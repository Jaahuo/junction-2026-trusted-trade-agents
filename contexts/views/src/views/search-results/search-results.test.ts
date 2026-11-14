import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { SearchResultSchema } from "@app/contract";
import { renderSearchResults } from "./search-results.ts";

const fixture = (name: string) =>
  Bun.file(resolve(import.meta.dir, `../../../fixtures/search-results/${name}.json`)).json();

// Traverse the rendered Lit templates without a browser DOM.
const text = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (
    value &&
    typeof value === "object" &&
    "strings" in value &&
    "values" in value &&
    Array.isArray(value.strings) &&
    Array.isArray(value.values)
  ) {
    const values: unknown[] = value.values;
    return value.strings
      .map((part: string, index: number) => `${part}${text(values[index])}`)
      .join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};
const visible = (value: unknown) =>
  text(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("unknown matches show as unknown, never as confirmed", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  const candidate = result.candidates.find((item) => item.match["lactose"] === "unknown");
  if (!candidate) throw new Error("Expected an unknown candidate");
  const output = visible(renderSearchResults({ ...result, candidates: [candidate] }));
  expect(output).toContain(candidate.name);
  expect(output).toMatch(/unknown/i);
  expect(output).not.toMatch(/confirmed/i);
});

test("a null orderQuantity shows quantity unknown", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  const candidate = result.candidates.find((item) => item.orderQuantity === null);
  if (!candidate) throw new Error("Expected a candidate with unknown quantity");
  const output = visible(
    renderSearchResults({
      ...result,
      candidates: [{ ...candidate, equals: { value: 987, unit: "LTR" } }],
    }),
  );
  expect(output).toMatch(/quantity unknown/i);
  expect(output).not.toMatch(/order quantity:\s*987\s*LTR/i);
});

test("the merged standing constraints are listed", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  const output = visible(renderSearchResults({ ...result, candidates: [] }));
  expect(output).toMatch(/lactose/i);
  expect(output).toMatch(/free(?:[_\s-]*from)?/i);
  expect(output).toMatch(/country\s*of\s*origin/i);
  expect(output).toMatch(/\bfi\b/i);
  expect(output).toMatch(/packaging\s*material/i);
  expect(output).toMatch(/returnable\s*glass/i);
});

test("known match and converted quantity are shown", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  const candidate = result.candidates.find((item) => item.match["lactose"] === "confirmed");
  if (!candidate) throw new Error("Expected a confirmed candidate");
  const output = visible(renderSearchResults({ ...result, candidates: [candidate] }));
  expect(output).toMatch(/confirmed/i);
  expect(output).toMatch(/4\s*CT/i);
  expect(output).toMatch(/48\s*LTR/i);
});
