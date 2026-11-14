import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linuxProcessesInWorktree,
  processesInWorktree,
  stopWorktreeProcesses,
} from "./worktree-cleanup.ts";

const spawn = (cwd: string, script: string) =>
  Bun.spawn([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });

const makeStat = (state: string, threads: number, flags = 0) =>
  `42 (name with ) parenthesis) ${state} 1 1 1 0 0 ${flags} 0 0 0 0 0 0 0 0 0 0 ${threads}`;

describe("worktree process cleanup", () => {
  test("discovers Linux cwd without scanning unrelated Docker mounts and fails closed", () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const uid = process.geteuid?.();
    if (uid === undefined) throw new Error("Cannot determine effective user ID");
    const foreignUid = uid === 0 ? 1 : 0;
    const statuses = new Map<string, string | Error>();
    let foreignCwdReads = 0;
    let selfPid = String(process.pid);
    let processNamespace: string | Error = "mnt:[1]";
    let foreignNamespaceReads = 0;
    const cwd = new Map<string, string | Error>([
      ["11", "/tmp/task"],
      ["12", "/tmp/task/nested"],
      ["13", "/tmp/task-other"],
      ["14", missing],
      ["15", missing],
      ["16", missing],
      ["17", denied],
    ]);
    const stats = new Map([
      ["14", "14 (zombie) Z 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 1"],
      ["15", "15 (kernel thread) S 1 1 1 0 0 2097152 0 0 0 0 0 0 0 0 0 0 1"],
    ]);
    let mountinfo = [
      "1 0 0:1 / /proc rw - proc proc rw",
      "2 1 0:2 / /var/lib/docker/rootfs/overlayfs/example rw - overlay overlay rw",
      "3 1 0:3 / /run/docker/netns/example rw - nsfs nsfs rw",
    ].join("\n");
    const proc = {
      readdir: (path: string) => {
        expect(path).toBe("/proc");
        return [...cwd.keys(), "self"];
      },
      readlink: (path: string) => {
        if (path === "/proc/self") return selfPid;
        if (path === "/proc/self/ns/mnt") return "mnt:[1]";
        if (path.endsWith("/ns/mnt")) {
          if (path === "/proc/17/ns/mnt") foreignNamespaceReads++;
          if (processNamespace instanceof Error) throw processNamespace;
          return processNamespace;
        }
        if (path === "/proc/17/cwd") foreignCwdReads++;
        const pid = path.split("/")[2];
        if (pid === undefined) throw missing;
        const value = cwd.get(pid);
        if (value instanceof Error) throw value;
        if (value === undefined) throw missing;
        return value;
      },
      readFile: (path: string) => {
        if (path === "/proc/self/mountinfo") return mountinfo;
        const pid = path.split("/")[2];
        if (pid === undefined) throw missing;
        if (path.endsWith("/status")) {
          const value = statuses.get(pid);
          if (value instanceof Error) throw value;
          return value ?? `Uid:\t${uid}\t${pid === "17" ? foreignUid : uid}\t${uid}\t${uid}\n`;
        }
        const value = stats.get(pid);
        if (value === undefined) throw missing;
        return value;
      },
    };
    expect(linuxProcessesInWorktree("/tmp/task", proc)).toEqual([11, 12]);
    expect(foreignCwdReads).toBe(0);
    expect(foreignNamespaceReads).toBe(0);
    selfPid = "999999999";
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("PID namespace");
    selfPid = String(process.pid);
    processNamespace = "mnt:[2]";
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("different mount namespace");
    processNamespace = denied;
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("denied");
    processNamespace = missing;
    stats.set("11", "present");
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("mount namespace");
    stats.delete("11");
    processNamespace = "mnt:[1]";
    statuses.set("11", denied);
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("denied");
    statuses.set("11", "Uid:\tinvalid\n");
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("Cannot determine ownership");
    statuses.set("11", missing);
    stats.set("11", "present");
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("Cannot determine ownership");
    stats.delete("11");
    expect(linuxProcessesInWorktree("/tmp/task", proc)).toEqual([12]);
    statuses.delete("11");
    cwd.set("16", denied);
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("denied");
    cwd.set("16", missing);
    stats.set("16", "16 (running) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1");
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("Cannot determine cwd");
    stats.set("16", "16 (exited leader) Z 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 2");
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("Cannot determine cwd");
    stats.delete("16");
    cwd.set("16", "/tmp/task (deleted)");
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("Cannot determine cwd");
    cwd.delete("16");
    mountinfo = "1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n";
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("complete /proc visibility");
  });

  test("classifies missing Linux cwd conservatively across process states and thread counts", () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const uid = process.geteuid?.();
    if (uid === undefined) throw new Error("Cannot determine effective user ID");
    let stat: string | Error = missing;
    let nextStat: string | Error | undefined;
    let cwdError = missing;
    const proc = {
      readdir: () => ["42"],
      readlink: (path: string) => {
        if (path === "/proc/self") return String(process.pid);
        if (path === "/proc/self/ns/mnt") return "mnt:[1]";
        throw cwdError;
      },
      readFile: (path: string) => {
        if (path === "/proc/self/mountinfo") return "1 0 0:1 / /proc rw - proc proc rw";
        if (path.endsWith("/status")) return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
        if (nextStat !== undefined) {
          const first = stat;
          stat = nextStat;
          nextStat = undefined;
          if (first instanceof Error) throw first;
          return first;
        }
        if (stat instanceof Error) throw stat;
        return stat;
      },
    };
    for (const state of ["Z", "X", "R", "S"]) {
      for (const threads of [0, 1, 2]) {
        stat = makeStat(state, threads);
        if ((state === "Z" || state === "X") && threads === 1) {
          expect(linuxProcessesInWorktree("/tmp/task", proc)).toEqual([]);
        } else {
          expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow(
            `Cannot determine cwd of process 42 (state ${state}, threads ${threads})`,
          );
        }
      }
    }
    stat = makeStat("Z", 0);
    nextStat = missing;
    expect(linuxProcessesInWorktree("/tmp/task", proc)).toEqual([]);
    stat = makeStat("X", 0);
    nextStat = makeStat("S", 2);
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow(
      "Cannot determine cwd of process 42 (state S, threads 2)",
    );
    stat = makeStat("Z", 0);
    nextStat = makeStat("Z", 1);
    expect(linuxProcessesInWorktree("/tmp/task", proc)).toEqual([]);
    stat = makeStat("X", 0);
    nextStat = makeStat("X", 0);
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow(
      "Cannot determine cwd of process 42 (state X, threads 0)",
    );
    stat = makeStat("Z", 0);
    nextStat = denied;
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("denied");
    stat = makeStat("Z", 0);
    nextStat = "invalid";
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("Invalid /proc/42/stat");
    stat = makeStat("S", 1, 0x00200000);
    expect(linuxProcessesInWorktree("/tmp/task", proc)).toEqual([]);
    stat = missing;
    expect(linuxProcessesInWorktree("/tmp/task", proc)).toEqual([]);
    stat = denied;
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("denied");
    cwdError = denied;
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("denied");
    cwdError = missing;
    stat = "invalid";
    expect(() => linuxProcessesInWorktree("/tmp/task", proc)).toThrow("Invalid /proc/42/stat");
  });

  test("selects only numeric PIDs with cwd inside the directory boundary", () => {
    const output = [
      "p11\0\nfcwd\0tDIR\0n/tmp/task with spaces\0\n",
      "p12\0\nfcwd\0tDIR\0n/tmp/task with spaces/nested/../nested\0\n",
      "p13\0\nfcwd\0tDIR\0n/tmp/task with spaces-other\0\n",
      "p14\0\nfcwd\0tDIR\0n/tmp/other/task with spaces\0\n",
    ].join("");
    expect(processesInWorktree(output, "/tmp/task with spaces/")).toEqual([11, 12]);
    expect(() =>
      processesInWorktree("p12oops\0\nfcwd\0tDIR\0n/tmp/task\0\n", "/tmp/task"),
    ).toThrow();
    expect(() => processesInWorktree("fcwd\0tDIR\0n/tmp/task\0\n", "/tmp/task")).toThrow();
    expect(() =>
      processesInWorktree(
        "p123\0\nfcwd\0tunknown\0n/proc/123/cwd (readlink: Permission denied)\0\n",
        "/tmp/task",
      ),
    ).toThrow();
    expect(() => processesInWorktree("p123\0\nfcwd\0n/tmp/task\0\n", "/tmp/task")).toThrow();
    expect(
      processesInWorktree(
        "p123\0\nfcwd\0tDIR\0n/proc/123/cwd (readlink: Permission denied)\0\n",
        "/proc/123",
      ),
    ).toEqual([123]);
    expect(() =>
      processesInWorktree(
        "p1\0\nfcwd\0tDIR\0n/tmp/task\0\np2\0\nfcwd\0n/tmp/task\0\n",
        "/tmp/task",
      ),
    ).toThrow();
    expect(() =>
      processesInWorktree("p1\0\nfcwd\0tDIR\0n/tmp/task\0\nfcwd\0n/tmp/task\0\n", "/tmp/task"),
    ).toThrow();
    expect(() => processesInWorktree("p1\0\nfcwd\0tDIR\0\n", "/tmp/task")).toThrow();
    expect(() => processesInWorktree("p1\0\nfcwd\0tDIR\0n/tmp/task", "/tmp/task")).toThrow();
  });

  test("terminates target processes, escalates stubborn processes and leaves siblings alone", async () => {
    const temp = await mkdtemp(join(tmpdir(), "cleanup regression "));
    const target = join(temp, "worktree space");
    const nested = join(target, "nested");
    const sibling = `${target}-other`;
    const children: Pick<Bun.Subprocess, "exitCode" | "signalCode" | "kill" | "exited">[] = [];
    try {
      await mkdir(nested, { recursive: true });
      await mkdir(sibling);
      const normal = spawn(target, 'console.log("ready"); setInterval(() => {}, 1000)');
      children.push(normal);
      const stubborn = spawn(
        nested,
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
      );
      children.push(stubborn);
      const outside = spawn(sibling, 'console.log("ready"); setInterval(() => {}, 1000)');
      children.push(outside);
      for (const child of [normal, stubborn, outside]) {
        const reader = child.stdout.getReader();
        const result = await reader.read();
        reader.releaseLock();
        if (result.done || !new TextDecoder().decode(result.value).includes("ready"))
          throw new Error("Test process did not start");
      }
      const stopped = await stopWorktreeProcesses(target);
      expect(stopped.toSorted((a, b) => a - b)).toEqual(
        [normal.pid, stubborn.pid].toSorted((a, b) => a - b),
      );
      await Promise.all([normal.exited, stubborn.exited]);
      expect(stubborn.signalCode).toBe("SIGKILL");
      expect(outside.exitCode).toBeNull();
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => child.exited));
      await rm(temp, { recursive: true, force: true });
    }
  }, 15000);

  test("refuses to stop its own caller ancestry", async () => {
    const error = await stopWorktreeProcesses(process.cwd()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining("caller or its ancestor"));
  }, 15000);
});
