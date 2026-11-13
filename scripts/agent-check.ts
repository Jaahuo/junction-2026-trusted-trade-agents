import process from "node:process";

const status = Bun.spawnSync(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
  stdout: "pipe",
  stderr: "inherit",
});
if (status.exitCode !== 0) process.exit(status.exitCode || 1);
if (status.stdout.length === 0) {
  console.log("No worktree changes; skipping agent checks.");
  process.exit(0);
}

const checks = [
  ["bun", "check"],
  ["bunx", "vp", "check"],
  ["bun", "scripts/changed-tests.ts"],
];
let failed = false;
for (const command of checks) {
  console.log(`\n$ ${command.join(" ")}`);
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) failed = true;
}
if (failed) {
  console.error("Agent checks failed.");
  process.exit(1);
}
console.log("Agent checks passed.");
