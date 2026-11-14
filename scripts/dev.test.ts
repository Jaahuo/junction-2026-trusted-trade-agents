import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const launcher = new URL("./dev.ts", import.meta.url).href;
const fixture = `
import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
const [dir, name, role] = process.argv.slice(2);
if (role === "parent") {
  process.on("SIGTERM", () => {});
  spawn(process.execPath, [import.meta.path, dir, name, "listener"], { stdio: "ignore" });
  await writeFile(dir + "/" + name + ".parent", String(process.pid));
  setInterval(() => {}, 1000);
} else if (role === "fail") {
  const timer = setInterval(async () => {
    try {
      await access(dir + "/fail");
      clearInterval(timer);
      process.exit(7);
    } catch {}
  }, 20);
} else {
  process.on("SIGTERM", () => {});
  const server = createServer();
  server.listen(0, "127.0.0.1", async () => {
    await writeFile(dir + "/" + name + ".listener", JSON.stringify({ pid: process.pid, port: server.address().port }));
  });
}
`;

// These are real subprocesses and sockets; polling observes OS state rather than
// advancing a fake clock in a different process.
async function eventually<T>(read: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await read();
    } catch (error) {
      last = error;
      await delay(50);
    }
  }
  throw last;
}

async function listening(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
  return promise;
}

async function gone(pid: number): Promise<boolean> {
  const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const state = result.stdout.toString().trim();
  return !state || state.startsWith("Z");
}

describe("dev process supervision", () => {
  for (const signal of ["SIGINT", "SIGTERM", "failure"] as const) {
    test(`stops process trees on ${signal}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "dev-supervision-"));
      const fixturePath = join(dir, "fixture.ts");
      await writeFile(fixturePath, fixture);
      const supervisor = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { runDevProcesses } from ${JSON.stringify(launcher)};
        process.exitCode = await runDevProcesses(${JSON.stringify(
          ["api", "web"].map((name) => ({
            command: process.execPath,
            args: [
              fixturePath,
              dir,
              name,
              signal === "failure" && name === "web" ? "fail" : "parent",
            ],
          })),
        )});
      `,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const parents: number[] = [];
      try {
        const listeners: { pid: number; port: number }[] = [];
        for (const name of signal === "failure" ? ["api"] : ["api", "web"]) {
          parents.push(
            Number(await eventually(() => readFile(join(dir, `${name}.parent`), "utf8"))),
          );
          const data = await eventually(() => readFile(join(dir, `${name}.listener`), "utf8"));
          const listener: { pid: number; port: number } = JSON.parse(data);
          listeners.push(listener);
          expect(await listening(listener.port)).toBe(true);
        }
        if (signal === "failure") await writeFile(join(dir, "fail"), "");
        else supervisor.kill(signal);
        expect(await supervisor.exited).toBe(
          signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 7,
        );
        for (const pid of [...parents, ...listeners.map((listener) => listener.pid)]) {
          await eventually(async () => {
            if (!(await gone(pid))) throw new Error(`PID ${pid} remains`);
          });
        }
        for (const listener of listeners) expect(await listening(listener.port)).toBe(false);
      } finally {
        supervisor.kill("SIGKILL");
        for (const pid of parents) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already stopped */
          }
        }
        await rm(dir, { recursive: true, force: true });
      }
    }, 15000);
  }
});
