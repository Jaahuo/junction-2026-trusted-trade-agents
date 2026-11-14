import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processesInWorktree, stopWorktreeProcesses } from "./worktree-cleanup.ts";

const spawn = (cwd: string, script: string) =>
  Bun.spawn([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });

describe("worktree process cleanup", () => {
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
