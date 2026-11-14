import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { equivalentHeads } from "./review-equivalence.ts";

// Git hooks export GIT_DIR, GIT_INDEX_FILE and similar; without this, a test run inside the
// pre-commit hook would init, configure and commit in the real repository instead of the temp one.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

const lines = (count: number, changes: Record<number, string> = {}) =>
  `${Array.from({ length: count }, (_, i) => changes[i + 1] ?? String(i + 1)).join("\n")}\n`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Each test gets its own repository: main with a.txt and b.txt, and a branch `pr` that changes
// line 25 of a.txt. Returns helpers and the reviewed head of `pr`.
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "review-equivalence-"));
  dirs.push(dir);
  const git = async (...args: string[]) =>
    (await $`git ${args}`.cwd(dir).quiet()).stdout.toString().trim();
  const write = (file: string, text: string) => Bun.write(join(dir, file), text);
  const commit = async (message: string) => {
    await git("add", ".");
    await git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await write("a.txt", lines(50));
  await write("b.txt", lines(20));
  await commit("base");
  await git("checkout", "-qb", "pr");
  await write("a.txt", lines(50, { 25: "25 changed by the PR" }));
  const reviewed = await commit("pr");
  const onMain = async (file: string, text: string) => {
    await git("checkout", "-q", "main");
    await write(file, text);
    await commit(`main ${file}`);
    await git("checkout", "-q", "pr");
  };
  const mergeMain = async () => {
    await git("merge", "-q", "--no-edit", "main");
    return git("rev-parse", "HEAD");
  };
  const equivalent = (head: string, reviewedHeads = [reviewed]) =>
    equivalentHeads({ head, main: "main", reviewed: reviewedHeads, cwd: dir });
  return { git, write, commit, onMain, mergeMain, equivalent, reviewed };
}

describe("review equivalence across merges from main", () => {
  test("keeps a review when main changed other files or distant lines", async () => {
    const repo = await setup();
    await repo.onMain("b.txt", lines(20, { 5: "5 changed on main" }));
    await repo.onMain("a.txt", lines(50, { 2: "2 changed on main" }));
    const head = await repo.mergeMain();
    expect(await repo.equivalent(head)).toEqual([repo.reviewed]);
  });

  test("keeps a review when main inserted lines that shift the PR's hunk", async () => {
    const repo = await setup();
    await repo.onMain("a.txt", `0a\n0b\n0c\n${lines(50)}`);
    const head = await repo.mergeMain();
    expect(await repo.equivalent(head)).toEqual([repo.reviewed]);
  });

  test("drops a review when main changed lines next to the PR's change", async () => {
    const repo = await setup();
    await repo.onMain("a.txt", lines(50, { 23: "23 changed on main" }));
    const head = await repo.mergeMain();
    expect(await repo.equivalent(head)).toEqual([]);
  });

  test("drops a review when a later commit changes only whitespace in the PR's lines", async () => {
    const repo = await setup();
    await repo.write("a.txt", lines(50, { 25: "25 changed  by the PR" }));
    const head = await repo.commit("whitespace");
    expect(await repo.equivalent(head)).toEqual([]);
  });

  test("drops a review when the PR's own change grew", async () => {
    const repo = await setup();
    await repo.write("b.txt", `${lines(20)}extra\n`);
    const head = await repo.commit("more");
    expect(await repo.equivalent(head)).toEqual([]);
  });

  test("drops a review when the merge from main resolved a conflict", async () => {
    const repo = await setup();
    await repo.onMain("a.txt", lines(50, { 25: "25 changed on main" }));
    await repo.git("merge", "-q", "--no-edit", "main").catch(() => undefined);
    await repo.write("a.txt", lines(50, { 25: "25 resolved" }));
    const head = await repo.commit("resolve");
    expect(await repo.equivalent(head)).toEqual([]);
  });

  test("ignores a reviewed head on another branch even with the same change", async () => {
    const repo = await setup();
    await repo.git("checkout", "-qb", "sibling", "main");
    await repo.write("a.txt", lines(50, { 25: "25 changed by the PR" }));
    const sibling = await repo.commit("same change elsewhere");
    await repo.git("checkout", "-q", "pr");
    await repo.onMain("b.txt", lines(20, { 5: "5 changed on main" }));
    const head = await repo.mergeMain();
    expect(await repo.equivalent(head, [sibling, "f".repeat(40)])).toEqual([]);
  });

  test("finds nothing when the PR has no change of its own", async () => {
    const repo = await setup();
    await repo.git("checkout", "-q", "main");
    expect(await repo.equivalent(await repo.git("rev-parse", "HEAD"))).toEqual([]);
  });
});
