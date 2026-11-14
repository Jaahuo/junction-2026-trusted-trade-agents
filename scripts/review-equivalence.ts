import { $ } from "bun";

// A PR's own change: its diff from where it meets main, as a stable patch id.
// Context lines count, so main edits next to the PR's hunks change the id and require a new review.
async function changeId(commit: string, main: string, cwd: string): Promise<string | undefined> {
  const base = await $`git merge-base ${main} ${commit}`.cwd(cwd).nothrow().quiet();
  if (base.exitCode !== 0) return undefined;
  const id = await $`git diff ${base.stdout.toString().trim()} ${commit} | git patch-id --stable`
    .cwd(cwd)
    .nothrow()
    .quiet();
  return id.exitCode === 0 ? id.stdout.toString().split(" ")[0] || undefined : undefined;
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
