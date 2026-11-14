import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { fail, git } from "./lib.ts";
import { hasRuntime } from "./runtime.ts";
import { parseWorktrees, worktreeCleanup } from "./workflow-policy.ts";

async function run(cmd: string[], cwd: string, env = process.env): Promise<boolean> {
  const child = Bun.spawn(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" });
  return (await child.exited) === 0;
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, resolve(path));
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
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
      if (isInside(root, path)) selected.add(pid);
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

type ProcReader = {
  readdir(path: string): string[];
  readlink(path: string): string;
  readFile(path: string): string;
};

const procReader: ProcReader = {
  readdir: (path) => readdirSync(path),
  readlink: (path) => readlinkSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
};

function missing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

function effectiveUid(): number {
  const uid = process.geteuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error("Cannot determine effective user ID");
  return uid;
}

// A missing cwd can indicate an exited process, zombie, kernel thread, or inaccessible cwd.
export function linuxProcessesInWorktree(root: string, proc: ProcReader = procReader): number[] {
  const uid = effectiveUid();
  if (proc.readlink("/proc/self") !== String(process.pid))
    throw new Error("Cannot establish /proc PID namespace");
  const mountNamespace = proc.readlink("/proc/self/ns/mnt");
  if (!/^mnt:\[\d+\]$/.test(mountNamespace)) throw new Error("Cannot determine mount namespace");
  const mounts = proc
    .readFile("/proc/self/mountinfo")
    .split("\n")
    .filter((line) => {
      const parts = line.split(" ");
      const separator = parts.indexOf("-");
      return (
        parts[3] === "/" &&
        parts[4] === "/proc" &&
        separator >= 6 &&
        parts[separator + 1] === "proc"
      );
    });
  const mount = mounts[0];
  if (
    mounts.length !== 1 ||
    mount === undefined ||
    /(?:^|[ ,])hidepid=(?!0(?:[ ,]|$))[^ ,]+/.test(mount)
  )
    throw new Error("Cannot establish complete /proc visibility");
  const resolvedRoot = resolve(root);
  const selected: number[] = [];
  for (const entry of proc.readdir("/proc")) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid)) throw new Error("Invalid PID in /proc");
    let status: string;
    try {
      status = proc.readFile(`/proc/${entry}/status`);
    } catch (error) {
      if (!missing(error)) throw error;
      try {
        proc.readFile(`/proc/${entry}/stat`);
      } catch (statError) {
        if (missing(statError)) continue;
        throw statError;
      }
      throw new Error(`Cannot determine ownership of process ${pid}`, { cause: error });
    }
    const uidLines = status.split("\n").filter((line) => line.startsWith("Uid:"));
    const uidLine = uidLines[0];
    const match =
      uidLines.length === 1 && uidLine !== undefined
        ? /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(uidLine)
        : null;
    if (!match || !Number.isSafeInteger(Number(match[2])))
      throw new Error(`Cannot determine ownership of process ${pid}`);
    if (Number(match[2]) !== uid) continue;
    let cwd: string;
    try {
      cwd = proc.readlink(`/proc/${entry}/cwd`);
    } catch (error) {
      if (!missing(error)) throw error;
      let stat: string;
      try {
        stat = proc.readFile(`/proc/${entry}/stat`);
      } catch (statError) {
        if (missing(statError)) continue;
        throw statError;
      }
      // comm is parenthesized and may contain spaces or closing parentheses.
      const end = stat.lastIndexOf(")");
      const fields =
        end < 0
          ? []
          : stat
              .slice(end + 1)
              .trim()
              .split(/\s+/);
      const flagsField = fields[6];
      const threadsField = fields[17];
      if (
        !stat.startsWith(`${entry} (`) ||
        fields.length < 18 ||
        flagsField === undefined ||
        threadsField === undefined ||
        !/^\d+$/.test(flagsField) ||
        !/^\d+$/.test(threadsField)
      )
        throw new Error(`Invalid /proc/${entry}/stat`, { cause: error });
      const flags = Number(flagsField);
      if (!Number.isSafeInteger(flags))
        throw new Error(`Invalid /proc/${entry}/stat`, { cause: error });
      if ((flags & 0x00200000) !== 0 || (fields[0] === "Z" && threadsField === "1")) continue;
      throw new Error(`Cannot determine cwd of process ${pid}`, { cause: error });
    }
    if (!isAbsolute(cwd) || cwd.endsWith(" (deleted)"))
      throw new Error(`Cannot determine cwd of process ${pid}`);
    let processMountNamespace: string;
    try {
      processMountNamespace = proc.readlink(`/proc/${entry}/ns/mnt`);
    } catch (error) {
      if (!missing(error)) throw error;
      try {
        proc.readFile(`/proc/${entry}/stat`);
      } catch (statError) {
        if (missing(statError)) continue;
        throw statError;
      }
      throw new Error(`Cannot determine mount namespace of process ${pid}`, { cause: error });
    }
    if (processMountNamespace !== mountNamespace)
      throw new Error(`Cannot determine cwd of process ${pid} in a different mount namespace`);
    if (isInside(resolvedRoot, cwd)) selected.push(pid);
  }
  return selected;
}

async function discoverProcesses(root: string): Promise<number[]> {
  if (process.platform === "linux") {
    const selected = linuxProcessesInWorktree(root);
    if (!linuxProcessesInWorktree(realpathSync(process.cwd())).includes(process.pid))
      throw new Error("/proc did not report the cleanup process cwd");
    return selected;
  }
  const output = await commandOutput([
    "lsof",
    "-a",
    "-u",
    String(effectiveUid()),
    "-d",
    "cwd",
    "-F0pnt",
  ]);
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
