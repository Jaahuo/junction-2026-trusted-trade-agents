import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fsSkillPack, parseFrontmatter, sha256 } from "./skill-files.ts";

const realDir = resolve(import.meta.dir, "../../../../skills/trusted-trade-ordering");
const md = "---\nname: trusted-trade-ordering\ndescription: Use when buying.\n---\n\n# Body\n";

describe("parseFrontmatter", () => {
  test("reads name and description", () => {
    expect(parseFrontmatter(md)).toEqual({
      ok: true,
      value: { name: "trusted-trade-ordering", description: "Use when buying." },
    });
  });

  test.each([
    ["no frontmatter", "# Body\n"],
    ["an invalid YAML block", "---\nname: [\n---\n"],
    ["a YAML list", "---\n- a\n---\n"],
    ["another skill name", "---\nname: other\n---\n"],
  ])("rejects %s", (_label, text) => {
    expect(parseFrontmatter(text)).toEqual({ ok: false, error: "INVALID_SKILL" });
  });
});

describe("fsSkillPack", () => {
  test("digests and sizes match the bytes of the files on disk", async () => {
    const snapshot = await fsSkillPack(() => realDir).snapshot();
    if (!snapshot.ok) throw new Error(snapshot.error);
    for (const { name, digest, size, bytes } of snapshot.value.files) {
      const disk = await Bun.file(resolve(realDir, name)).bytes();
      expect({ name, digest, size, bytes }).toEqual({
        name,
        digest: sha256(disk),
        size: disk.byteLength,
        bytes: disk,
      });
    }
  });

  test("the manifest names are exactly the files in the skill folder", async () => {
    const snapshot = await fsSkillPack(() => realDir).snapshot();
    if (!snapshot.ok) throw new Error(snapshot.error);
    const manifest: string[] = snapshot.value.files.map(({ name }) => name);
    expect(manifest.toSorted()).toEqual((await readdir(realDir, { recursive: true })).toSorted());
  });

  test("a missing folder is UNAVAILABLE", async () => {
    expect(await fsSkillPack(() => resolve(realDir, "missing")).snapshot()).toEqual({
      ok: false,
      error: "UNAVAILABLE",
    });
  });
});
