import { fail, git } from "./lib.ts";
import { command, ghJson, option, repository } from "./workflow.ts";
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
--merge explicitly requests a squash merge after gate, current-main and risk checks.
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
const head = await command("git", "rev-parse", "HEAD");
await command("git", "fetch", "origin", "main");
const main = await command("git", "rev-parse", "origin/main");
if (!(await git("merge-base", "--is-ancestor", main, head)).ok)
  fail("Branch is behind origin/main. Update it before shipping.");
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

const pull = await ghJson(decodePull, "api", path);
if (pull.state !== "open" || pull.base.ref !== "main") fail("PR is no longer open against main.");
await command("git", "fetch", "origin", "main");
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
    author: pull.user.login,
    reviews,
    agentReviews,
    checks: result.check_runs,
  });
} catch (error) {
  fail(String(error));
}
// GitHub atomically rejects a changed PR head; branch protection must enforce up-to-date main and gate server-side.
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
if (!taskIssue) await cleanMergedWorktree(branch, head);
else {
  const finish = Bun.spawn(
    ["bun", "scripts/task.ts", "finish", taskIssue, "--pr", String(pr.number)],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await finish.exited) !== 0)
    fail(`Merged, but finish failed; run bun run task finish ${taskIssue} --pr ${pr.number}.`);
}
