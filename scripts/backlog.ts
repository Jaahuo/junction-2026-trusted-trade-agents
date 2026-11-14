import { projectStatus } from "./board.ts";
import { fail } from "./lib.ts";
import { command, ghJson, option, repository } from "./workflow.ts";
import {
  decodeBacklogIssues,
  decodeIssueStates,
  decodeOpenPrs,
  decodeUser,
} from "./workflow-decode.ts";

/** Labels that mean a person must act before an agent can finish the issue. */
const BLOCKING_LABELS = new Set([
  "blocked",
  "needs-decision",
  "risk:lock-in",
  "kind:spike",
  "question",
]);
/** Titles of issues that only a person can close: mentor questions and team decisions. */
const PERSON_ONLY_TITLE = /^(mentor question|decide|ask the mentors|status:)/i;
/** Exit code of `claim` when another agent holds the issue: pick the next one. */
export const TAKEN_EXIT = 3;

export interface BacklogIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  status: string | null;
}

export interface Board {
  /** Every open issue. */
  open: BacklogIssue[];
  /** Issue numbers that are closed. */
  closed: ReadonlySet<number>;
  /** Open PRs: their number, head branch and the issues they close. */
  prs: { number: number; headRefName: string; closes: number[] }[];
  /** Issue numbers with a remote `task/<n>` branch: a claim. */
  claimed: ReadonlySet<number>;
}

/** The text under a `## heading`, up to the next `## ` heading; null when the heading is missing. */
export function section(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** Every `#<n>` reference in the "Depends on" section, "Merge after" included. */
export function dependencies(body: string): number[] {
  const text = section(body, "depends on") ?? "";
  return [...new Set([...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1])))];
}

/** The backticked paths on the "Owned paths:" line, without trailing globs. */
export function ownedPaths(body: string): string[] {
  const line = (section(body, "owns") ?? "")
    .split(/\r?\n/)
    .find((entry) => /^owned paths:/i.test(entry.trim()));
  if (line === undefined) return [];
  return [...line.matchAll(/`([^`]+)`/g)]
    .map((match) => (match[1] ?? "").replace(/(\/\*\*?)+$/, "").replace(/\*+$/, ""))
    .filter((path) => path.length > 0);
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** True when a path of one list equals or contains a path of the other. */
export function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) => b.some((right) => within(left, right) || within(right, left)));
}

const prFor = (board: Board, number: number) =>
  board.prs.find((pr) => pr.closes.includes(number) || pr.headRefName === `task/${number}`);

/** An issue someone works on: assigned, in progress, claimed or with an open PR, and not Done. */
function active(issue: BacklogIssue, board: Board): boolean {
  if (issue.status === "Done") return false;
  return (
    issue.assignees.length > 0 ||
    (issue.status !== null && issue.status !== "Todo") ||
    board.claimed.has(issue.number) ||
    prFor(board, issue.number) !== undefined
  );
}

/** Why an agent cannot take the issue now and finish it start to end; empty when it can. */
export function blockers(issue: BacklogIssue, board: Board): string[] {
  const reasons: string[] = [];
  if (issue.assignees.length > 0) reasons.push(`assigned to ${issue.assignees.join(", ")}`);
  if (issue.status !== null && issue.status !== "Todo") reasons.push(`board ${issue.status}`);
  if (board.claimed.has(issue.number)) reasons.push(`claimed: task/${issue.number} exists`);
  const pr = prFor(board, issue.number);
  if (pr !== undefined) reasons.push(`open PR #${pr.number}`);
  for (const label of issue.labels.filter((entry) => BLOCKING_LABELS.has(entry)))
    reasons.push(`label ${label}`);
  if (PERSON_ONLY_TITLE.test(issue.title)) reasons.push("needs a person");
  if (section(issue.body, "acceptance") === null) reasons.push("no acceptance criteria");
  const openPrs = new Set(board.prs.map((entry) => entry.number));
  const openIssues = new Set(board.open.map((entry) => entry.number));
  for (const dependency of dependencies(issue.body)) {
    if (dependency === issue.number || board.closed.has(dependency)) continue;
    if (openIssues.has(dependency) || openPrs.has(dependency))
      reasons.push(`depends on open #${dependency}`);
  }
  const paths = ownedPaths(issue.body);
  for (const other of board.open) {
    if (other.number === issue.number || !active(other, board)) continue;
    if (overlaps(paths, ownedPaths(other.body)))
      reasons.push(`owned paths overlap active #${other.number}`);
  }
  return reasons;
}

const waveOf = (issue: BacklogIssue) =>
  Number(issue.labels.find((label) => label.startsWith("wave:"))?.slice(5) ?? 99);

/** Demo-critical first, then lower wave, then stretch last, then oldest. */
export function rank(issues: readonly BacklogIssue[]): BacklogIssue[] {
  const key = (issue: BacklogIssue) => [
    issue.labels.includes("demo-critical") ? 0 : 1,
    issue.labels.includes("stretch") ? 1 : 0,
    waveOf(issue),
    issue.number,
  ];
  return issues.toSorted((a, b) => {
    const left = key(a);
    const right = key(b);
    const index = left.findIndex((value, at) => value !== right[at]);
    return index < 0 ? 0 : (left[index] ?? 0) - (right[index] ?? 0);
  });
}

/** The ready issues in pick order, and the rest with their blockers. */
export function plan(board: Board) {
  const checked = rank(board.open).map((issue) => ({ issue, reasons: blockers(issue, board) }));
  return {
    ready: checked.filter((entry) => entry.reasons.length === 0).map((entry) => entry.issue),
    waiting: checked.filter((entry) => entry.reasons.length > 0),
  };
}

async function run(program: string, ...args: string[]) {
  const child = Bun.spawn([program, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, text: `${out}${err}` };
}

async function loadBoard(): Promise<Board> {
  const [open, states, prs, heads] = await Promise.all([
    ghJson(
      decodeBacklogIssues,
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "500",
      "--json",
      "number,title,body,labels,assignees,projectItems",
    ),
    ghJson(
      decodeIssueStates,
      "issue",
      "list",
      "--state",
      "closed",
      "--limit",
      "2000",
      "--json",
      "number,state",
    ),
    ghJson(
      decodeOpenPrs,
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,headRefName,closingIssuesReferences",
    ),
    command("git", "ls-remote", "--heads", "origin", "task/*"),
  ]);
  const claimed = new Set(
    [...heads.matchAll(/refs\/heads\/task\/(\d+)$/gm)].map((match) => Number(match[1])),
  );
  return { open, closed: new Set(states.map((entry) => entry.number)), prs, claimed };
}

const numberArg = (value: string | undefined): number => {
  if (!value || !/^[1-9]\d*$/.test(value)) fail("Provide a positive issue number; see --help.");
  return Number(value);
};

async function next(args: string[]) {
  const { ready, waiting } = plan(await loadBoard());
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(ready.map(({ number, title, labels }) => ({ number, title, labels }))),
    );
    return;
  }
  console.log(ready.length ? "Ready, in pick order:" : "No issue is ready for an agent.");
  for (const issue of ready) console.log(`  #${issue.number} ${issue.title}`);
  if (!args.includes("--all")) return;
  console.log("\nWaiting:");
  for (const { issue, reasons } of waiting)
    console.log(`  #${issue.number} ${issue.title}\n      ${reasons.join("; ")}`);
}

async function claim(number: number, args: string[]) {
  const board = await loadBoard();
  const issue = board.open.find((entry) => entry.number === number);
  if (!issue) fail(`#${number} is not an open issue.`);
  const reasons = blockers(issue, board);
  if (reasons.length) {
    console.error(`#${number} is not ready: ${reasons.join("; ")}`);
    process.exit(TAKEN_EXIT);
  }
  const repo = await repository();
  const main = (await command("git", "ls-remote", "origin", "refs/heads/main")).split(/\s/)[0];
  if (!main) fail("Could not read origin/main.");
  // The refs API refuses an existing ref, so of two agents that claim at once exactly one wins.
  const created = await run(
    "gh",
    "api",
    `repos/${repo.nameWithOwner}/git/refs`,
    "-f",
    `ref=refs/heads/task/${number}`,
    "-f",
    `sha=${main}`,
  );
  if (created.code !== 0) {
    if (/Reference already exists|HTTP 422/.test(created.text)) {
      console.error(`#${number} was claimed by another agent; pick the next issue.`);
      process.exit(TAKEN_EXIT);
    }
    fail(`Claim of #${number} failed:\n${created.text.trim()}`);
  }
  const user = await ghJson(decodeUser, "api", "user");
  const agent = option(args, "--agent") ?? "backlog-loop agent";
  await command("gh", "issue", "edit", String(number), "--add-assignee", user.login);
  await command(
    "gh",
    "issue",
    "comment",
    String(number),
    "--body",
    `Claimed by ${agent} for @${user.login} through the backlog loop (remote branch \`task/${number}\`).`,
  );
  console.log(`Claimed #${number}. Next: bun scripts/task.ts start ${number}`);
}

async function release(number: number, args: string[]) {
  const reason = option(args, "--reason");
  if (!reason) fail("Provide --reason with what is done and what blocks the issue.");
  const repo = await repository();
  const user = await ghJson(decodeUser, "api", "user");
  const board = await loadBoard();
  const issue = board.open.find((entry) => entry.number === number);
  if (!issue) fail(`#${number} is not an open issue.`);
  if (!issue.assignees.some((login) => login.toLowerCase() === user.login.toLowerCase()))
    fail(`#${number} is not assigned to you; release only your own claim.`);
  const pr = prFor(board, number);
  if (pr) fail(`#${number} has open PR #${pr.number}; close or hand over the PR first.`);
  await command("git", "fetch", "origin", "main", `task/${number}`);
  const pushed = await run(
    "git",
    "merge-base",
    "--is-ancestor",
    `origin/task/${number}`,
    "origin/main",
  );
  if (pushed.code !== 0)
    fail(`origin/task/${number} holds commits that are not on main; open a draft PR instead.`);
  await command(
    "gh",
    "api",
    "-X",
    "DELETE",
    `repos/${repo.nameWithOwner}/git/refs/heads/task/${number}`,
  );
  await command("gh", "issue", "edit", String(number), "--remove-assignee", user.login);
  await projectStatus(repo, number, "Todo", true);
  await command(
    "gh",
    "issue",
    "comment",
    String(number),
    "--body",
    `Released by the backlog loop: ${reason}`,
  );
  console.log(`Released #${number}. Remove the local worktree with: wt remove task/${number}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const action = args[0];
  if (!action || args.includes("--help")) {
    console.log(`Usage:
  bun scripts/backlog.ts next [--all] [--json]
  bun scripts/backlog.ts claim <issue> [--agent <label>]
  bun scripts/backlog.ts release <issue> --reason <text>

next lists the open issues an agent can finish start to end now, in pick order:
unassigned, Todo or off the board, no remote task/<n> branch, no open PR, no
blocking label, not a mentor question or decision, with an Acceptance section,
every "Depends on" and "Merge after" issue closed, and owned paths clear of every
active issue. --all also lists the others with their blockers.
claim creates the remote branch task/<issue> through the GitHub refs API. GitHub
refuses an existing ref, so one agent wins; the others exit ${TAKEN_EXIT} and pick the next
issue. The winner is assigned. Then run: bun scripts/task.ts start <issue>.
release gives back your claim with no pushed work: it deletes the remote branch,
unassigns you, moves the issue to Todo and comments the reason.`);
    process.exit(0);
  }
  if (action === "next") await next(args);
  else if (action === "claim") await claim(numberArg(args[1]), args);
  else if (action === "release") await release(numberArg(args[1]), args);
  else fail("Unknown backlog command; see --help.");
}
