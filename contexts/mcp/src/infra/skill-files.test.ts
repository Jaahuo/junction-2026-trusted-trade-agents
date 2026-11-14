import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fsSkillPack, parseFrontmatter, sha256 } from "./skill-files.ts";

const realDir = resolve(import.meta.dir, "../../../../skills/trusted-trade-ordering");
const skillText = () => Bun.file(resolve(realDir, "SKILL.md")).text();
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

describe("the trusted-trade-ordering skill text", () => {
  test("names the multi-product path: one search per product, batched quotes, one order", async () => {
    const text = await skillText();
    expect(text).toContain("Call `find_products` once per product the user names");
    expect(text).toContain("the same full request for every product");
    expect(text).toContain("Call `quote_offers` once with the shortlist for every product");
    expect(text).toContain(
      "Call `place_order` once, with `offers` (one chosen `offerId` per product, up to 20 chosen offers",
    );
    expect(text).toContain("Never place one order per product");
    expect(text).toContain("rather than silently placing a partial order");
    expect(text).toContain("`search_products` and `get_offers` only when the user asks");
    expect(text).toContain("The server generates the idempotency key");
    expect(text).toContain(
      "select up to 20 unchosen offers as `alternatives` across the entire order",
    );
    expect(text).toContain("up to 20 alternatives across the entire order");
    expect(text).toContain(
      "The two limits are separate: retain the chosen offer for every requested product",
    );
  });

  test("states the choice rule in order: pre-check, price per standard unit, delivery date", async () => {
    const text = await skillText();
    const order = ["**Pre-check.**", "**Price per standard unit.**", "**Delivery date.**"].map(
      (rule) => text.indexOf(rule),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(text).toContain("`claims.pricePerStandardUnit.gross`");
    expect(text).toContain("Compare only offers with the same `unit`");
    expect(text).toContain("When it is `null`, do not compute one");
  });
});
