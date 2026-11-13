import { resolve } from "node:path";

try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  if (typeof input !== "object" || input === null) throw new Error("Expected Stop hook input.");
  if (!("stop_hook_active" in input && input.stop_hook_active === true)) {
    if (!("cwd" in input) || typeof input.cwd !== "string")
      throw new Error("Expected the active worktree cwd.");
    const repository = Bun.spawnSync(
      ["git", "-C", resolve(input.cwd), "rev-parse", "--show-toplevel"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (repository.exitCode !== 0) throw new Error(repository.stderr.toString());
    const root = repository.stdout.toString().trim();
    const child = Bun.spawn(["bun", "--no-orphans", "scripts/agent-check.ts"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      console.log(
        JSON.stringify({
          decision: "block",
          reason: `Agent checks failed (exit ${exitCode}).\n${stdout}${stderr}`,
        }),
      );
    }
  }
} catch (error) {
  console.log(
    JSON.stringify({ decision: "block", reason: `Agent checks could not run: ${String(error)}` }),
  );
}
