import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { equivalentHeads } from "./review-equivalence.ts";

const lines = (count: number, change?: [number, string]) =>
  `${Array.from({ length: count }, (_, i) => (change && i + 1 === change[0] ? change[1] : String(i + 1))).join("\n")}\n`;

// Git hooks export GIT_DIR, GIT_INDEX_FILE and similar; without this, a test run inside the
// pre-commit hook would init, configure and commit in the real repository instead of the temp one.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

let dir = "";
const run = async (strings: TemplateStringsArray, ...values: string[]) =>
  (
    await $(strings, ...values)
      .cwd(dir)
      .quiet()
  ).stdout
    .toString()
    .trim();
const write = (file: string, text: string) => Bun.write(join(dir, file), text);
const commitOnMain = async (file: string, text: string) => {
  await run`git checkout -q main`;
  await write(file, text);
  await run`git commit -qam ${`main ${file}`}`;
  await run`git checkout -q pr`;
  await run`git merge -q --no-edit main`;
  return run`git rev-parse HEAD`;
};

let reviewed = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "review-equivalence-"));
  await run`git init -q -b main`;
  await run`git config user.email test@example.com`;
  await run`git config user.name test`;
  await write("a.txt", lines(50));
  await write("b.txt", lines(20));
  await run`git add .`;
  await run`git commit -qm base`;
  await run`git checkout -qb pr`;
  await write("a.txt", lines(50, [25, "25 changed by the PR"]));
  await run`git commit -qam pr`;
  reviewed = await run`git rev-parse HEAD`;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("review equivalence across merges from main", () => {
  test("keeps a review when main changed other files or distant lines", async () => {
    await commitOnMain("b.txt", lines(20, [5, "5 changed on main"]));
    const head = await commitOnMain("a.txt", lines(50, [2, "2 changed on main"]));
    expect(await equivalentHeads({ head, main: "main", reviewed: [reviewed], cwd: dir })).toEqual([
      reviewed,
    ]);
  });

  test("drops a review when main changed lines next to the PR's change", async () => {
    const text = (await Bun.file(join(dir, "a.txt")).text()).replace("\n23\n", "\n23 on main\n");
    await run`git checkout -q main`;
    await write("a.txt", text.replace("\n25 changed by the PR\n", "\n25\n"));
    await run`git commit -qam ${"main near"}`;
    await run`git checkout -q pr`;
    await run`git merge -q --no-edit main`;
    const head = await run`git rev-parse HEAD`;
    expect(await equivalentHeads({ head, main: "main", reviewed: [reviewed], cwd: dir })).toEqual(
      [],
    );
  });

  test("drops a review when the PR's own change grew", async () => {
    await write("b.txt", `${await Bun.file(join(dir, "b.txt")).text()}extra\n`);
    await run`git commit -qam ${"more"}`;
    const head = await run`git rev-parse HEAD`;
    expect(await equivalentHeads({ head, main: "main", reviewed: [reviewed], cwd: dir })).toEqual(
      [],
    );
  });

  test("ignores unknown commits and commits that are not ancestors", async () => {
    const head = await run`git rev-parse HEAD`;
    const base = await run`git rev-parse main`;
    expect(
      await equivalentHeads({ head, main: "main", reviewed: ["f".repeat(40), base], cwd: dir }),
    ).toEqual([]);
  });
});
