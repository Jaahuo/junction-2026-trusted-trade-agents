import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processesInWorktree, stopWorktreeProcesses } from "./worktree-cleanup.ts";

describe("worktree process cleanup", () => {
  test("selects only numeric PIDs with cwd inside the directory boundary", () => {
    const output = [
      "p11\0n/tmp/task with spaces\0\n",
      "p12\0n/tmp/task with spaces/nested/../nested\0\n",
      "p13\0n/tmp/task with spaces-other\0\n",
      "p14\0n/tmp/other/task with spaces\0\n",
    ].join("");
    expect(processesInWorktree(output, "/tmp/task with spaces/")).toEqual([11, 12]);
    expect(() => processesInWorktree("p12oops\0n/tmp/task\0", "/tmp/task")).toThrow();
    expect(() => processesInWorktree("n/tmp/task\0", "/tmp/task")).toThrow();
  });

  test("terminates target processes, escalates stubborn processes and leaves siblings alone", async () => {
    const temp = await mkdtemp(join(tmpdir(), "cleanup regression "));
    const target = join(temp, "worktree space");
    const nested = join(target, "nested");
    const sibling = `${target}-other`;
    await mkdir(nested, { recursive: true });
    await mkdir(sibling);
    const children = [
      Bun.spawn([process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
        cwd: target,
        stdout: "pipe",
        stderr: "pipe",
      }),
      Bun.spawn(
        [
          process.execPath,
          "-e",
          'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
        ],
        { cwd: nested, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn([process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
        cwd: sibling,
        stdout: "pipe",
        stderr: "pipe",
      }),
    ];
    const [normal, stubborn, outside] = children;
    if (!normal || !stubborn || !outside) throw new Error("Failed to start test processes");
    try {
      for (const child of children) {
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
