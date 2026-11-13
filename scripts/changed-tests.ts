// Deleted modules and global configuration changes need more than Bun's import graph.
export function needsFullTests(changes: string): boolean {
  const fields = changes.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (
      status.startsWith("D") ||
      // Bun's changed graph can miss imports through workspace package exports.
      path.startsWith("packages/") ||
      path === "DESIGN.md" ||
      /^(?:package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bunfig\.toml)$/.test(
        name,
      ) ||
      /^tsconfig(?:\..+)?\.json$/.test(name) ||
      /^(?:vite|vitest|jest|test)\.config\.[cm]?[jt]s$/.test(name)
    ) {
      return true;
    }
  }
  return false;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode || 1);
  return result.stdout.toString();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const base = args[0] ?? "HEAD";
  if (args.length > 1 || base === "" || base.startsWith("-")) {
    console.error("Usage: bun scripts/changed-tests.ts [base]");
    process.exit(1);
  }

  // Check the index too: an unstaged reversal must not hide a staged configuration change.
  const worktree = git("diff", "--name-status", "-z", "--no-renames", base, "--");
  const index = git("diff", "--cached", "--name-status", "-z", "--no-renames", base, "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
  // Use the full suite for untracked files because selection with an explicit base is uncertain.
  const full = needsFullTests(worktree) || needsFullTests(index) || untracked.length > 0;
  console.log(
    full
      ? "Running all tests (shared package, configuration, deletion, or untracked changes)."
      : `Running tests affected by changes since ${base}.`,
  );
  const command = full ? ["bun", "test"] : ["bun", "test", `--changed=${base}`];
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}
