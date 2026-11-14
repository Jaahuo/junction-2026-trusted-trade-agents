import { projectStatus } from "./board.ts";
import { fail } from "./lib.ts";
import { command, ghJson, option, repository } from "./workflow.ts";
import {
  decodeBacklogIssues,
  decodeIssueComments,
  decodeIssueStates,
  decodeOpenPrs,
  decodeProjectTitles,
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
const PERSON_ONLY_TITLE = /^(mentor question|decide|decision|ask the mentors|status:)/i;
/** A loop claim with no pushed commit for this long may be expired by any agent. */
const STALE_MS = 90 * 60_000;
const CLAIM_NOTE = /^Claimed by .* for @([\w-]+) through the backlog loop/;
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
  /** Issue numbers that are closed, and PR numbers that are merged: finished dependencies. */
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

const INLINE_DEPENDENCY = /^\W*(depends on|merge after|blocked by)\b.*$/gim;

/**
 * Every `#<n>` an issue waits for: the "Depends on" and "Merge after" sections, and any line that
 * starts with "Depends on", "Merge after" or "Blocked by".
 */
export function dependencies(body: string): number[] {
  const text = [
    section(body, "depends on") ?? "",
    section(body, "merge after") ?? "",
    ...[...body.matchAll(INLINE_DEPENDENCY)].map((match) => match[0]),
  ].join("\n");
  return [...new Set([...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1])))];
}

/**
 * A path as a plain directory or file prefix: no leading `./`, and everything from the first glob
 * segment on dropped, so `./scripts/**` and `contexts/<glob>/src` widen to `scripts` and `contexts`.
 * Null when nothing path-like is left.
 */
export function canonicalPath(raw: string): string | null {
  const segments: string[] = [];
  for (const segment of raw.trim().split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || segment.includes("*")) break;
    if (!/^[\w.@-]+$/.test(segment)) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

const looksLikePath = (word: string) => /^[\w.@*-]+\/|^[\w@-]+\.[a-z]{1,5}[.,;:]?$/i.test(word);

/**
 * The backticked paths the "Owns" section owns: its "Owned paths:" line and the bullets under it,
 * not the "Keep out of" line or its bullets. Null when the section is missing or owns no path,
 * so the caller can refuse to guess.
 */
export function ownedPaths(body: string): string[] | null {
  const owns = section(body, "owns");
  if (owns === null) return null;
  const paths: string[] = [];
  let owning = true;
  for (const line of owns.split(/\r?\n/)) {
    if (/^\W*keep out of\b/i.test(line)) owning = false;
    else if (/^\W*owned paths\b/i.test(line)) owning = true;
    else if (!/^\s*[-*]\s/.test(line) && line.trim() !== "") owning = true;
    if (!owning) continue;
    const quoted = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
    // Outside backticks, also take the words that look like paths.
    const bare = line
      .replace(/`[^`]*`/g, " ")
      .replace(/\(?\bexcept\s+[\w./*@-]+\)?/gi, " ")
      .split(/[,;]\s*|\s+/)
      .filter(looksLikePath);
    const tokens = [...quoted, ...bare];
    for (const token of tokens) {
      const path = canonicalPath(token.replace(/^[-*:]+|[.,;:]+$/g, ""));
      if (path !== null) paths.push(path);
    }
  }
  return paths.length > 0 ? [...new Set(paths)] : null;
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
    reasons.push(
      openIssues.has(dependency) || openPrs.has(dependency)
        ? `depends on open #${dependency}`
        : `depends on #${dependency}, which is neither closed nor merged`,
    );
  }
  const paths = ownedPaths(issue.body);
  if (paths === null) reasons.push("no owned paths");
  else
    for (const other of overlapping(issue, paths, board))
      reasons.push(`owned paths overlap active #${other.number}`);
  return reasons;
}

const areas = (issue: BacklogIssue) => issue.labels.filter((label) => label.startsWith("area:"));

/**
 * Active issues that may touch the same files: their owned paths overlap these paths, or, when
 * their Owns section cannot be read, they share an `area:` label (fail closed within the area).
 */
export function overlapping(
  issue: BacklogIssue,
  paths: readonly string[],
  board: Board,
): BacklogIssue[] {
  return board.open.filter((other) => {
    if (other.number === issue.number || !active(other, board)) return false;
    const theirs = ownedPaths(other.body);
    if (theirs === null) return areas(other).some((area) => areas(issue).includes(area));
    return overlaps(paths, theirs);
  });
}

const waveOf = (issue: BacklogIssue) =>
  Number(issue.labels.find((label) => label.startsWith("wave:"))?.slice(5) ?? 99);

/** Demo-critical first, then lower wave (R-04), then stretch last, then oldest. */
export function rank(issues: readonly BacklogIssue[]): BacklogIssue[] {
  const key = (issue: BacklogIssue) => [
    issue.labels.includes("demo-critical") ? 0 : 1,
    waveOf(issue),
    issue.labels.includes("stretch") ? 1 : 0,
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

/** The title of the one project board linked to the repository. */
async function linkedProject(repo: { owner: { login: string }; name: string }): Promise<string> {
  const titles = await ghJson(
    decodeProjectTitles,
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){projectsV2(first:5){nodes{title}}}}",
    "-f",
    `owner=${repo.owner.login}`,
    "-f",
    `repo=${repo.name}`,
  );
  const [title] = titles;
  if (titles.length !== 1 || title === undefined)
    fail("Repository must be linked to exactly one project board.");
  return title;
}

async function loadBoard(): Promise<Board> {
  const project = await linkedProject(await repository());
  const [issues, states, merged, prs, heads] = await Promise.all([
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
      decodeIssueStates,
      "pr",
      "list",
      "--state",
      "merged",
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
  const open = issues.map(({ number, title, body, labels, assignees, projects }): BacklogIssue => ({
    number,
    title,
    body,
    labels,
    assignees,
    status: projects.find((item) => item.title === project)?.status ?? null,
  }));
  const closed = new Set([...states, ...merged].map((entry) => entry.number));
  return { open, closed, prs, claimed };
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

type Repo = Awaited<ReturnType<typeof repository>>;

/**
 * Deletes the remote `task/<n>` only while it still points at `expected`: a push in between makes
 * the lease fail, so pushed work is never deleted.
 */
async function dropClaim(number: number, expected: string): Promise<boolean> {
  const ref = `refs/heads/task/${number}`;
  const pushed = await run(
    "git",
    "push",
    `--force-with-lease=${ref}:${expected}`,
    "origin",
    `:${ref}`,
  );
  return pushed.code === 0;
}

/** Undoes a reservation this run created when a later claim step fails; never returns. */
async function unwind(number: number, main: string, why: string): Promise<never> {
  const dropped = await dropClaim(number, main);
  fail(
    `${why}\n${
      dropped
        ? `The reservation task/${number} was removed; the issue is free again.`
        : `Remove the reservation by hand once you checked it holds no work: git push origin :refs/heads/task/${number}`
    }`,
  );
}

async function claim(number: number, args: string[]) {
  const agent = option(args, "--agent") ?? "backlog-loop agent";
  const [repo, user, board] = await Promise.all([
    repository(),
    ghJson(decodeUser, "api", "user"),
    loadBoard(),
  ]);
  const issue = board.open.find((entry) => entry.number === number);
  if (!issue) fail(`#${number} is not an open issue.`);
  const reasons = blockers(issue, board);
  if (reasons.length) {
    console.error(`#${number} is not ready: ${reasons.join("; ")}`);
    process.exit(TAKEN_EXIT);
  }
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
    if (/Reference already exists/.test(created.text)) {
      console.error(`#${number} was claimed by another agent; pick the next issue.`);
      process.exit(TAKEN_EXIT);
    }
    fail(`Claim of #${number} failed:\n${created.text.trim()}`);
  }
  // Assign before anything else can fail, so a half-done claim is always yours to release.
  const assigned = await run("gh", "issue", "edit", String(number), "--add-assignee", user.login);
  if (assigned.code !== 0)
    await unwind(number, main, `Assigning #${number} failed:\n${assigned.text.trim()}`);
  // Claims of different issues do not serialize. Every overlapping issue that became active
  // after the ready check is a rival claimed at the same time: give way to any of them. Two
  // rivals may both give way, but two can never both proceed.
  const after = await loadBoard();
  const rival = overlapping(issue, ownedPaths(issue.body) ?? [], after)[0];
  if (rival) {
    const dropped = await dropClaim(number, main);
    // Keep the assignment when the drop failed, so release still accepts you.
    if (dropped) await run("gh", "issue", "edit", String(number), "--remove-assignee", user.login);
    console.error(
      `#${rival.number} was claimed at the same time and owns overlapping paths; ${
        dropped
          ? `gave #${number} back`
          : `run: bun scripts/backlog.ts release ${number} --reason "rival claim"`
      }. Pick the next issue.`,
    );
    process.exit(TAKEN_EXIT);
  }
  const note = `Claimed by ${agent} for @${user.login} through the backlog loop (remote branch \`task/${number}\`).`;
  const commented = await run("gh", "issue", "comment", String(number), "--body", note);
  if (commented.code !== 0)
    console.error(`Claimed, but the claim comment failed:\n${commented.text.trim()}`);
  console.log(`Claimed #${number}. Next: bun scripts/task.ts start ${number}`);
}

async function release(number: number, args: string[]) {
  const reason = option(args, "--reason");
  if (!reason) fail("Provide --reason with what is done and what blocks the issue.");
  const blocked = args.includes("--blocked");
  const [repo, user, board]: [Repo, { login: string }, Board] = await Promise.all([
    repository(),
    ghJson(decodeUser, "api", "user"),
    loadBoard(),
  ]);
  const issue = board.open.find((entry) => entry.number === number);
  if (!issue) fail(`#${number} is not an open issue.`);
  if (!issue.assignees.some((login) => login.toLowerCase() === user.login.toLowerCase()))
    fail(`#${number} is not assigned to you; release only your own claim.`);
  const pr = prFor(board, number);
  if (pr) fail(`#${number} has open PR #${pr.number}; close or hand over the PR first.`);
  // Label first: the issue must never be claimable while its blocker is unrecorded.
  if (blocked) await command("gh", "issue", "edit", String(number), "--add-label", "blocked");
  if (board.claimed.has(number)) {
    const head = (await command("git", "ls-remote", "origin", `refs/heads/task/${number}`)).split(
      /\s/,
    )[0];
    if (!head) fail(`Could not read origin task/${number}.`);
    await command("git", "fetch", "origin", "main", head);
    const merged = await run("git", "merge-base", "--is-ancestor", head, "origin/main");
    if (merged.code !== 0)
      fail(`task/${number} holds commits that are not on main; open a draft PR instead.`);
    if (!(await dropClaim(number, head)))
      fail(`task/${number} moved while releasing; someone pushed work. Nothing was deleted.`);
  }
  await command("gh", "issue", "edit", String(number), "--remove-assignee", user.login);
  await projectStatus(repo, number, "Todo", true);
  await command(
    "gh",
    "issue",
    "comment",
    String(number),
    "--body",
    `Released by the backlog loop${blocked ? " and labelled blocked until a person clears it" : ""}:\n\n${reason}`,
  );
  console.log(`Released #${number}. Remove the local worktree with: wt remove task/${number}`);
}

/**
 * The loop claim behind an issue's remote branch: who it is for and when it was made; null when the
 * branch was not made by the loop.
 */
export function loopClaim(comments: readonly { body: string; createdAt: string }[]) {
  for (const comment of comments.toReversed()) {
    const match = CLAIM_NOTE.exec(comment.body);
    if (match?.[1]) return { login: match[1], at: Date.parse(comment.createdAt) };
  }
  return null;
}

/** True when a loop claim is older than the stale limit and its branch holds no pushed commit. */
export const isStale = (claimedAt: number, now: number, pushed: boolean) =>
  !pushed && now - claimedAt >= STALE_MS;

async function stale() {
  const board = await loadBoard();
  await command("git", "fetch", "origin", "main");
  const now = Date.now();
  let found = 0;
  for (const issue of board.open) {
    if (!board.claimed.has(issue.number) || prFor(board, issue.number)) continue;
    const comments = await ghJson(
      decodeIssueComments,
      "issue",
      "view",
      String(issue.number),
      "--json",
      "comments",
    );
    const claimed = loopClaim(comments);
    if (claimed === null) continue;
    const head = (
      await command("git", "ls-remote", "origin", `refs/heads/task/${issue.number}`)
    ).split(/\s/)[0];
    if (!head) continue;
    await command("git", "fetch", "origin", head);
    const pushed =
      (await run("git", "merge-base", "--is-ancestor", head, "origin/main")).code !== 0;
    if (!isStale(claimed.at, now, pushed)) continue;
    found++;
    const minutes = Math.round((now - claimed.at) / 60_000);
    console.log(
      `#${issue.number} claimed for @${claimed.login} ${minutes} min ago, nothing pushed. If that agent is gone, @${claimed.login} runs: bun scripts/backlog.ts release ${issue.number} --reason "agent stopped"`,
    );
  }
  if (found === 0) console.log("No stale loop claims.");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const action = args[0];
  if (!action || args.includes("--help")) {
    console.log(`Usage:
  bun scripts/backlog.ts next [--all] [--json]
  bun scripts/backlog.ts claim <issue> [--agent <label>]
  bun scripts/backlog.ts release <issue> --reason <text> [--blocked]
  bun scripts/backlog.ts stale

next lists the open issues an agent can finish start to end now, in pick order:
unassigned, Todo or off the board, no remote task/<n> branch, no open PR, no
blocking label, not a mentor question or decision, with an Acceptance section,
every "Depends on" and "Merge after" issue closed, and owned paths clear of every
active issue. --all also lists the others with their blockers.
claim creates the remote branch task/<issue> through the GitHub refs API. GitHub
refuses an existing ref, so one agent wins; the others exit ${TAKEN_EXIT} and pick the next
issue. A claim that races an issue with overlapping owned paths gives way; in a
rare tie both give way, never both proceed. The winner is assigned. Then run: bun scripts/task.ts start <issue>.
release gives back your claim with no pushed work: it deletes the remote branch
only while it holds no new commits, unassigns you, moves the issue to Todo and
comments the reason. --blocked also labels it blocked, so no agent picks it until a
person removes the label.
stale lists loop claims older than 90 minutes whose branch holds no pushed commit,
for a person to release; it changes nothing, so a slow live agent is never cut off.`);
    process.exit(0);
  }
  if (action === "next") await next(args);
  else if (action === "claim") await claim(numberArg(args[1]), args);
  else if (action === "release") await release(numberArg(args[1]), args);
  else if (action === "stale") await stale();
  else fail("Unknown backlog command; see --help.");
}
