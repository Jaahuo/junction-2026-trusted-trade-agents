import { resolve } from "node:path";
import { fail, git } from "./lib.ts";
import { parseWorktrees, worktreeCleanup } from "./workflow-policy.ts";

async function run(cmd: string[], cwd: string, env = process.env): Promise<boolean> {
  const child = Bun.spawn(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" });
  return (await child.exited) === 0;
}

async function decide(branch: string, mergedHead: string) {
  const worktrees = parseWorktrees((await git("worktree", "list", "--porcelain")).out);
  const mainPath = worktrees[0]?.path;
  const worktree = worktrees.find((entry) => entry.branch === branch);
  if (!mainPath || !worktree) return { mainPath, worktree, decision: undefined };
  const status = await git("-C", worktree.path, "status", "--porcelain");
  const decision = worktreeCleanup({
    worktree,
    mainPath,
    callerPath: process.cwd(),
    dirty: !status.ok || status.out !== "",
    mergedHead,
  });
  return { mainPath, worktree, decision };
}

export async function cleanMergedWorktree(
  branch: string,
  mergedHead: string,
  rerun: string,
): Promise<void> {
  const { mainPath, worktree, decision } = await decide(branch, mergedHead);
  if (!mainPath) return console.log("No main worktree found; cleanup skipped.");
  if (!worktree || !decision) {
    const local = await git("rev-parse", "--verify", `refs/heads/${branch}`);
    if (local.ok && local.out === mergedHead && (await git("branch", "-D", branch)).ok)
      console.log(`Deleted local branch ${branch}.`);
    return;
  }
  const keep = (reason: string) =>
    console.log(`Kept worktree ${worktree.path}: ${reason}. From ${mainPath}, run: ${rerun}`);
  if (!decision.remove) return keep(decision.reason);
  if (await Bun.file(resolve(worktree.path, ".local/runtime.json")).exists()) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "DATABASE_URL"),
    );
    if (!(await run(["bun", "scripts/runtime.ts", "drop", "--yes"], worktree.path, env)))
      return keep("its database drop failed");
  }
  const again = await decide(branch, mergedHead);
  if (!again.decision?.remove) return keep(again.decision?.reason ?? "it changed during cleanup");
  // Squash merges leave the branch unmerged by ancestry, so -D is needed; the HEAD check guards it.
  if (!(await run(["wt", "remove", branch, "--foreground", "-D"], mainPath)))
    return keep("wt remove failed");
  console.log(`Removed worktree ${worktree.path} and branch ${branch}.`);
}

if (import.meta.main) {
  const [branch, mergedHead] = process.argv.slice(2);
  if (!branch || !mergedHead || !/^[a-f0-9]{40,64}$/.test(mergedHead))
    fail("Usage: bun scripts/worktree-cleanup.ts <branch> <merged-pr-head-sha>");
  await cleanMergedWorktree(
    branch,
    mergedHead,
    `bun scripts/worktree-cleanup.ts ${branch} ${mergedHead}`,
  );
}
