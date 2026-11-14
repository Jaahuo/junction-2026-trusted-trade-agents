import { fail, git } from "./lib.ts";
import { command, ghJson, option, repository } from "./workflow.ts";
import { equivalentHeads } from "./review-equivalence.ts";
import { cleanMergedWorktree } from "./worktree-cleanup.ts";
import {
  agentReviewComment,
  agentReviewMarker,
  parseAgentReview,
  parseRisk,
  requireMergeEvidence,
} from "./workflow-policy.ts";
import {
  decodeChecks,
  decodeComments,
  decodeMerge,
  decodePrs,
  decodePull,
  decodeReviews,
  decodeUser,
} from "./workflow-decode.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`Usage: bun scripts/ship.ts --risk ordinary|impact|lock-in [--review-file report.json] [--merge]
Push the branch and create or update its PR. --review-file posts a durable
independent agent report: JSON with head, taskOwnerAgent, reviewerAgent, method,
findings and verdict ("approved"). The head must be the full current commit SHA.
--merge explicitly requests a squash merge after the gate and risk checks; it
waits for a running gate. An ordinary PR may be behind main when GitHub reports
no conflicts; the gate on main is the backstop. Impact and lock-in PRs must
include current main: ship merges origin/main into the branch (no rebase, no
force-push), waits for the new gate and retries. A review of an earlier head
still counts when the PR's own change is identical (same git patch-id).
Impact accepts an independent agent report or GitHub approval; lock-in requires
independent human GitHub approval. Agent independence is a convention, not
cryptographically verified or enforced by branch protection. Without strict
branch protection, checks are client-side and main may move between the base
check and merge; GitHub still checks the exact PR head during merge.`);
  process.exit(0);
}
const risk = parseRisk(`Risk: ${option(args, "--risk") ?? ""}`);
if ((await git("status", "--porcelain")).out) fail("Commit all changes before shipping.");
const branch = await command("git", "branch", "--show-current");
if (!branch || branch === "main") fail("Ship from a task branch, never main.");
const taskIssue = /^task\/([1-9]\d*)$/.exec(branch)?.[1];
const closeLine = taskIssue ? `Closes #${taskIssue}` : "";
const sleep = (seconds: number) => Bun.sleep(seconds * 1000);
// Impact and lock-in merge only on current main; bring it in with a merge commit.
async function includeMain(): Promise<string> {
  await command("git", "fetch", "origin", "main");
  const behind = !(await git("merge-base", "--is-ancestor", "origin/main", "HEAD")).ok;
  if (behind && risk !== "ordinary") {
    if (!(await git("merge", "--no-edit", "origin/main")).ok) {
      await git("merge", "--abort");
      fail("Branch conflicts with origin/main. Merge origin/main, resolve, commit and rerun ship.");
    }
    console.log("Merged origin/main into the branch.");
  }
  return command("git", "rev-parse", "HEAD");
}
let head = await includeMain();
const repo = await repository();
const prs = await ghJson(
  decodePrs,
  "pr",
  "list",
  "--head",
  branch,
  "--base",
  "main",
  "--state",
  "open",
  "--json",
  "number,body",
);
if (prs.length > 1) fail("Multiple open PRs found for this branch; resolve manually.");
await command("git", "push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`);
let pr = prs[0];
if (!pr) {
  await command(
    "gh",
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--fill",
    "--body",
    `Risk: ${risk}${closeLine ? `\n\n${closeLine}` : ""}`,
  );
  const created = await ghJson(
    decodePrs,
    "pr",
    "list",
    "--head",
    branch,
    "--base",
    "main",
    "--state",
    "open",
    "--json",
    "number,body",
  );
  pr = created[0];
  if (!pr || created.length !== 1) fail("Could not uniquely find the created PR.");
} else {
  const body = (pr.body ?? "").replace(/^Risk:\s*\S+\s*$/gim, "").trim();
  const closing =
    closeLine &&
    !new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${taskIssue}\\b`, "i").test(body)
      ? `\n\n${closeLine}`
      : "";
  await command(
    "gh",
    "api",
    `repos/${repo.nameWithOwner}/pulls/${pr.number}`,
    "-X",
    "PATCH",
    "-f",
    `body=${body}${closing}${body || closing ? "\n\n" : ""}Risk: ${risk}`,
  );
}
const path = `repos/${repo.nameWithOwner}/pulls/${pr.number}`;
const reviewFile = option(args, "--review-file");
if (reviewFile) {
  const value: unknown = JSON.parse(await Bun.file(reviewFile).text());
  const report = parseAgentReview(value);
  if (report.head !== head) fail("Review report does not match the exact current head.");
  const pull = await ghJson(decodePull, "api", path);
  const user = await ghJson(decodeUser, "api", "user");
  if (pull.head.sha !== head || pull.user.login.toLowerCase() !== user.login.toLowerCase())
    fail("Only the PR author may post a report for the current PR head.");
  await command(
    "gh",
    "pr",
    "comment",
    String(pr.number),
    "--body",
    `${agentReviewMarker}\n${JSON.stringify(report)}`,
  );
}
console.log(`PR #${pr.number} updated at ${head}; risk: ${risk}.`);
if (!args.includes("--merge")) process.exit(0);

async function waitForGate(sha: string): Promise<void> {
  for (let waited = 0; waited <= 20 * 60; waited += 15) {
    const { check_runs } = await ghJson(
      decodeChecks,
      "api",
      `repos/${repo.nameWithOwner}/commits/${sha}/check-runs?per_page=100`,
    );
    const gates = check_runs.filter((check) => check.name === "gate");
    if (gates.length > 0 && gates.every((check) => check.status === "completed")) return;
    if (waited === 0) console.log(`Waiting for the gate on ${sha.slice(0, 7)}...`);
    await sleep(15);
  }
  fail("The gate did not finish within 20 minutes; rerun ship when it has.");
}
async function readPull() {
  for (let attempt = 1; ; attempt++) {
    const value = await ghJson(decodePull, "api", path);
    if (value.mergeable !== null || attempt === 6) return value;
    await sleep(5);
  }
}

let pull = await readPull();
for (let attempt = 1; ; attempt++) {
  if (attempt > 6)
    fail("Main kept moving or the PR head did not match after 6 attempts; rerun ship.");
  if (pull.state !== "open" || pull.base.ref !== "main") fail("PR is no longer open against main.");
  const updated = await includeMain();
  if (updated !== head) {
    head = updated;
    await command("git", "push", "origin", `HEAD:refs/heads/${branch}`);
    console.log(`Pushed ${head.slice(0, 7)}; the gate runs again.`);
  }
  await waitForGate(head);
  pull = await readPull();
  if (pull.head.sha === head) {
    await command("git", "fetch", "origin", "main");
    if ((await git("merge-base", "--is-ancestor", "origin/main", head)).ok || risk === "ordinary")
      break;
  }
}
const currentMain = await command("git", "rev-parse", "origin/main");
const reviews = (
  await ghJson(decodeReviews, "api", "--paginate", "--slurp", `${path}/reviews?per_page=100`)
).flat();
const result = await ghJson(
  decodeChecks,
  "api",
  `repos/${repo.nameWithOwner}/commits/${pull.head.sha}/check-runs?per_page=100`,
);
const comments = (
  await ghJson(
    decodeComments,
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo.nameWithOwner}/issues/${pr.number}/comments?per_page=100`,
  )
).flat();
const agentReviews = comments.flatMap((comment) => {
  if (comment.user.login.toLowerCase() !== pull.user.login.toLowerCase()) return [];
  const report = agentReviewComment(comment.body);
  return report ? [report] : [];
});
try {
  const declaredRisk = parseRisk(pull.body);
  if (declaredRisk !== risk) throw new Error("PR risk changed; inspect it before retrying.");
  requireMergeEvidence({
    risk: declaredRisk,
    head: pull.head.sha,
    localHead: head,
    base: pull.base.sha,
    currentMain,
    baseIsAncestor: (await git("merge-base", "--is-ancestor", currentMain, head)).ok,
    mergeable: pull.mergeable,
    equivalentHeads: await equivalentHeads({
      head,
      main: currentMain,
      reviewed: [
        ...reviews.flatMap((review) => (review.commit_id ? [review.commit_id] : [])),
        ...agentReviews.map((review) => review.head),
      ],
    }),
    author: pull.user.login,
    reviews,
    agentReviews,
    checks: result.check_runs,
  });
} catch (error) {
  fail(String(error));
}
// GitHub atomically rejects a changed PR head. Without branch protection, main may still move before
// this merge; the gate on main catches combined breakage after the fact.
const merged = await ghJson(
  decodeMerge,
  "api",
  `${path}/merge`,
  "-X",
  "PUT",
  "-f",
  `sha=${head}`,
  "-f",
  "merge_method=squash",
);
if (!merged.merged) fail("GitHub did not merge the PR.");
console.log(`Squash merged PR #${pr.number}.`);
if (!taskIssue)
  await cleanMergedWorktree(branch, head, `bun scripts/worktree-cleanup.ts ${branch} ${head}`);
else {
  const finish = Bun.spawn(
    ["bun", "scripts/task.ts", "finish", taskIssue, "--pr", String(pr.number)],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await finish.exited) !== 0)
    fail(`Merged, but finish failed; run bun run task finish ${taskIssue} --pr ${pr.number}.`);
}
