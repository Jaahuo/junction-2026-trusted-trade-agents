import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { fail, git } from "./lib.ts";
import { hasRuntime } from "./runtime.ts";
import { parseWorktrees, worktreeCleanup } from "./workflow-policy.ts";

async function run(cmd: string[], cwd: string, env = process.env): Promise<boolean> {
  const child = Bun.spawn(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" });
  return (await child.exited) === 0;
}

// lsof -F0 separates fields with NUL and records with a newline.
export function processesInWorktree(output: string, worktreePath: string): number[] {
  const root = resolve(worktreePath);
  const selected = new Set<number>();
  let pid: number | undefined;
  let file = false;
  let type: string | undefined;
  let named = false;
  const finishRecord = () => {
    if (pid !== undefined && (!file || type !== "DIR" || !named))
      throw new Error("Invalid cwd record in lsof output");
  };
  const fields = output.split("\0");
  if (fields.pop()?.replace(/\n/g, "") !== "") throw new Error("Unterminated field in lsof output");
  for (const raw of fields) {
    const field = raw.replace(/^\n+/, "");
    if (field.startsWith("p")) {
      finishRecord();
      const value = field.slice(1);
      if (!/^[1-9]\d*$/.test(value)) throw new Error("Invalid PID in lsof output");
      pid = Number(value);
      if (!Number.isSafeInteger(pid)) throw new Error("Invalid PID in lsof output");
      file = false;
      type = undefined;
      named = false;
    } else if (field.startsWith("f")) {
      if (pid === undefined) throw new Error("Missing PID in lsof output");
      if (file) finishRecord();
      if (field !== "fcwd") throw new Error("Invalid file in lsof output");
      file = true;
      type = undefined;
      named = false;
    } else if (field.startsWith("t")) {
      if (!file || type !== undefined || named) throw new Error("Invalid type in lsof output");
      type = field.slice(1);
      if (type !== "DIR") throw new Error("Invalid type in lsof output");
    } else if (field.startsWith("n")) {
      if (pid === undefined || !file || type !== "DIR" || named)
        throw new Error("Invalid cwd record in lsof output");
      const path = field.slice(1);
      if (!isAbsolute(path)) throw new Error("Invalid cwd in lsof output");
      named = true;
      const fromRoot = relative(root, resolve(path));
      if (
        fromRoot === "" ||
        (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
      )
        selected.add(pid);
    } else {
      throw new Error("Invalid field in lsof output");
    }
  }
  finishRecord();
  return [...selected];
}

async function commandOutput(cmd: string[]): Promise<string> {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 || errors.trim()) throw new Error(`${cmd[0]} failed: ${errors.trim() || code}`);
  return output;
}

async function protectedProcesses(): Promise<Set<number>> {
  const output = await commandOutput(["ps", "-axo", "pid=,ppid="]);
  const parents = new Map<number, number>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error("Invalid process list");
    parents.set(Number(match[1]), Number(match[2]));
  }
  const protectedPids = new Set<number>();
  let current = process.pid;
  while (current > 0 && !protectedPids.has(current)) {
    protectedPids.add(current);
    const parent = parents.get(current);
    if (parent === undefined) throw new Error("Cannot determine caller ancestry");
    current = parent;
  }
  return protectedPids;
}

async function discoverProcesses(root: string): Promise<number[]> {
  const output = await commandOutput(["lsof", "-a", "-d", "cwd", "-F0pnt"]);
  if (!processesInWorktree(output, realpathSync(process.cwd())).includes(process.pid))
    throw new Error("lsof did not report the cleanup process cwd");
  return processesInWorktree(output, root);
}

function signalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export async function stopWorktreeProcesses(worktreePath: string): Promise<number[]> {
  const root = realpathSync(worktreePath);
  const protectedPids = await protectedProcesses();
  const initial = await discoverProcesses(root);
  if (initial.some((pid) => protectedPids.has(pid)))
    throw new Error("a caller or its ancestor is running inside the worktree");
  const stopped = new Set<number>();
  for (const pid of initial) {
    if (!(await discoverProcesses(root)).includes(pid)) continue;
    if (signalProcess(pid, "SIGTERM")) {
      stopped.add(pid);
      console.log(`Sent SIGTERM to worktree process ${pid}.`);
    }
  }
  if (initial.length === 0) return [];
  await Bun.sleep(500);
  const survivors = await discoverProcesses(root);
  if (survivors.some((pid) => protectedPids.has(pid)))
    throw new Error("a caller or its ancestor is running inside the worktree");
  for (const pid of survivors) {
    if (!stopped.has(pid)) throw new Error(`new worktree process ${pid} appeared during cleanup`);
    if (!(await discoverProcesses(root)).includes(pid)) continue;
    if (signalProcess(pid, "SIGKILL")) console.log(`Sent SIGKILL to worktree process ${pid}.`);
  }
  if (survivors.length) {
    await Bun.sleep(500);
    if ((await discoverProcesses(root)).length)
      throw new Error("worktree processes are still running");
  }
  return [...stopped];
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
    console.log(
      `Kept worktree ${worktree.path}: ${reason}. From ${mainPath}, run:\n  git pull --ff-only origin main\n  ${rerun}`,
    );
  if (!decision.remove) return keep(decision.reason);
  try {
    await stopWorktreeProcesses(worktree.path);
  } catch (error) {
    return keep(
      `process cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (await hasRuntime(worktree.path)) {
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
