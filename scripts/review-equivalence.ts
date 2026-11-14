import { $ } from "bun";

// A PR's own change: its exact diff from where it meets main, with only blob ids and hunk line
// numbers removed so that main edits elsewhere in a file do not count. Whitespace, context lines,
// binary content and modes all count, so any edit to the PR's lines or next to them changes the id.
async function changeId(commit: string, main: string, cwd: string): Promise<string | undefined> {
  const base = await $`git merge-base ${main} ${commit}`.cwd(cwd).nothrow().quiet();
  if (base.exitCode !== 0) return undefined;
  const diff =
    await $`git -c diff.noprefix=false -c diff.mnemonicPrefix=false diff --no-color --no-ext-diff --no-textconv --binary ${base.stdout.toString().trim()} ${commit}`
      .cwd(cwd)
      .nothrow()
      .quiet();
  const text = diff.stdout.toString();
  if (diff.exitCode !== 0 || !text) return undefined;
  const normalized = text
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@"))
    .join("\n");
  return new Bun.CryptoHasher("sha256").update(normalized).digest("hex");
}

// Reviewed heads that are ancestors of head and carry exactly the same change, for example
// when the only later commits merge origin/main without touching the PR's own lines.
export async function equivalentHeads(input: {
  head: string;
  main: string;
  reviewed: string[];
  cwd?: string;
}): Promise<string[]> {
  const cwd = input.cwd ?? process.cwd();
  const current = await changeId(input.head, input.main, cwd);
  if (!current) return [];
  const result: string[] = [];
  for (const commit of new Set(input.reviewed)) {
    if (commit === input.head) continue;
    const ancestor = await $`git merge-base --is-ancestor ${commit} ${input.head}`
      .cwd(cwd)
      .nothrow()
      .quiet();
    if (ancestor.exitCode === 0 && (await changeId(commit, input.main, cwd)) === current)
      result.push(commit);
  }
  return result;
}
