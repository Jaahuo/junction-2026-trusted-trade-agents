import { resolve } from "node:path";
import { git } from "./lib.ts";
import { parseWorktrees, worktreeCleanup } from "./workflow-policy.ts";

async function run(cmd: string[], cwd: string, env = process.env): Promise<boolean> {
  const child = Bun.spawn(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" });
  return (await child.exited) === 0;
}

export async function cleanMergedWorktree(branch: string, mergedHead: string): Promise<void> {
  const worktrees = parseWorktrees((await git("worktree", "list", "--porcelain")).out);
  const mainPath = worktrees[0]?.path;
  if (!mainPath) return console.log("No main worktree found; cleanup skipped.");
  const worktree = worktrees.find((entry) => entry.branch === branch);
  if (!worktree) {
    const local = await git("rev-parse", "--verify", `refs/heads/${branch}`);
    if (local.ok && local.out === mergedHead && (await git("branch", "-D", branch)).ok)
      console.log(`Deleted local branch ${branch}.`);
    return;
  }
  const status = await git("-C", worktree.path, "status", "--porcelain");
  const decision = worktreeCleanup({
    worktree,
    mainPath,
    dirty: !status.ok || status.out !== "",
    mergedHead,
  });
  if (!decision.remove)
    return console.log(`Kept worktree ${worktree.path}: ${decision.reason}. Clean it up by hand.`);
  if (await Bun.file(resolve(worktree.path, ".local/runtime.json")).exists()) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "DATABASE_URL"),
    );
    if (!(await run(["bun", "scripts/runtime.ts", "drop", "--yes"], worktree.path, env)))
      return console.log(`Kept worktree ${worktree.path}: its database drop failed.`);
  }
  // Squash merges leave the branch unmerged by ancestry, so -D is needed; the HEAD check above guards it.
  if (!(await run(["wt", "remove", branch, "--foreground", "-D"], mainPath)))
    return console.log(`Could not remove worktree ${worktree.path}; remove it with wt remove.`);
  console.log(`Removed worktree ${worktree.path} and branch ${branch}.`);
}
