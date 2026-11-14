import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { assertDevPortsAvailable, loadRuntime } from "./runtime.ts";

type DevCommand = { command: string; args: string[]; cwd?: string };

// Each child owns a process group, including descendants that outlive their leader.
export async function runDevProcesses(
  commands: DevCommand[],
  onSpawn?: (pid: number) => void,
): Promise<number> {
  const groups: number[] = [];
  const { promise: stopped, resolve: stop } = Promise.withResolvers<number>();
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  const signalGroups = (signal: NodeJS.Signals) => {
    for (const pid of groups) {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  };

  try {
    try {
      for (const { command, args, cwd } of commands) {
        const child = spawn(command, args, {
          ...(cwd ? { cwd } : {}),
          detached: true,
          stdio: "inherit",
        });
        if (child.pid !== undefined) groups.push(child.pid);
        child.once("error", (error) => {
          console.error(`Failed to start ${command}:`, error);
          stop(1);
        });
        child.once("exit", (code, signal) => {
          if (signal) console.error(`${command} exited on ${signal}`);
          else console.error(`${command} exited with code ${code}`);
          stop(code || 1);
        });
        if (child.pid !== undefined) onSpawn?.(child.pid);
      }
    } catch (error) {
      console.error("Failed to start development processes:", error);
      stop(1);
    }

    const code = await stopped;
    signalGroups("SIGTERM");
    // Wait even when group leaders have exited: descendants may still be alive.
    await delay(500);
    signalGroups("SIGKILL");
    return code;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (import.meta.main) {
  await loadRuntime();
  await assertDevPortsAvailable();
  process.exitCode = await runDevProcesses([
    { command: "bun", args: ["--hot", "apps/api/src/main.ts"] },
    { command: "bunx", args: ["vp", "dev"], cwd: "apps/web" },
  ]);
}
