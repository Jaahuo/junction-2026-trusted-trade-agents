import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_FILES, readSource } from "./source.ts";
import { failureOf, fictionalProducts, writeFictionalSources } from "./test-fixtures.ts";

const withSource = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "catalogue-validation-"));
  try {
    await writeFictionalSources(dir);
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("input rejects empty identities and unsafe nested numbers without dropping fields", async () =>
  withSource(async (dir) => {
    for (const [changed, message] of [
      [{ ...fictionalProducts[0], id: " " }, "Empty product ID"],
      [
        { ...fictionalProducts[0], custom: { value: Number.MAX_SAFE_INTEGER + 1 } },
        "unsafe number",
      ],
    ] as const) {
      await writeFile(join(dir, DATA_FILES.products), JSON.stringify([changed]));
      expect(await failureOf(readSource(dir))).toContain(message);
    }
  }));

test("source paths must be absolute, outside Git and cannot escape through a file symlink", async () => {
  expect(await failureOf(readSource("relative-source"))).toContain("absolute");
  const insideGit = await mkdtemp(join(import.meta.dir, ".source-validation-"));
  try {
    expect(await failureOf(readSource(insideGit))).toContain("outside Git");
  } finally {
    await rm(insideGit, { recursive: true, force: true });
  }
  await withSource(async (dir) => {
    const outside = await mkdtemp(join(tmpdir(), "catalogue-outside-"));
    try {
      const target = join(outside, "products.json");
      await writeFile(target, JSON.stringify(fictionalProducts));
      await rm(join(dir, DATA_FILES.products));
      await symlink(target, join(dir, DATA_FILES.products));
      expect(await failureOf(readSource(dir))).toContain("escapes directory");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
