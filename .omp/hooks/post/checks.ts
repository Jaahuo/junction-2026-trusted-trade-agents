import { fileURLToPath } from "node:url";

type StopResult = { continue: true; additionalContext: string } | void;
type ExtensionAPI = {
  on(event: "session_stop", handler: (event: { signal: AbortSignal }) => Promise<StopResult>): void;
};

const root = fileURLToPath(new URL("../../..", import.meta.url));

export default function checks(pi: ExtensionAPI): void {
  pi.on("session_stop", async (event) => {
    let failure: string | undefined;
    try {
      const child = Bun.spawn(["bun", "--no-orphans", "scripts/agent-check.ts"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        // Finish before OMP's 30-second handler deadline instead of losing the result.
        timeout: 25_000,
        signal: event.signal,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (event.signal.aborted) return undefined;
      if (exitCode !== 0)
        failure = `Agent checks failed or exceeded the stop-hook deadline (exit ${exitCode}). Run bun scripts/agent-check.ts with a background tool and resolve failures before finishing.\n${stdout}${stderr}`;
    } catch (error) {
      failure = `Agent checks could not run: ${String(error)}`;
    }

    if (event.signal.aborted) return undefined;
    if (failure) return { continue: true, additionalContext: failure };
    return undefined;
  });
}
