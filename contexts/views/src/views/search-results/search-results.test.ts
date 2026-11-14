import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { SearchResultSchema } from "@app/contract";
import { setLang } from "../../shared/locale.ts";
import { renderNoResults, renderSearchResults } from "./search-results.ts";

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

test("a null quantity shows its reason", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  const candidate = result.candidates.find((item) => item.orderQuantity === null);
  if (!candidate?.quantityReason) throw new Error("Expected a candidate with a quantity reason");
  const render = (item: typeof candidate) =>
    visible(renderSearchResults({ ...result, candidates: [item] }));
  const output = render({ ...candidate, equals: { value: 987, unit: "LTR" } });
  expect(output).toContain(`Quantity unknown. ${candidate.quantityReason}`);
  expect(output).not.toContain("987");
  const { quantityReason: _, ...withoutReason } = candidate;
  expect(render(withoutReason)).toContain(
    "Quantity unknown. The product data does not say how much one sales unit holds.",
  );
});

test("the merged standing constraints are listed", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  const output = visible(renderSearchResults({ ...result, candidates: [] }));
  expect(output).toContain("Lactose free");
  expect(output).toContain("Country of origin: Finland");
  expect(output).toContain("Packaging material: Returnable glass");
});

test("two required constraints show two different names", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  // The contract accepts only lactose until #71; the view must name any attribute it is given.
  const [candidate] = result.candidates;
  if (!candidate) throw new Error("Expected a candidate");
  const output = visible(
    renderSearchResults({
      ...result,
      candidates: [{ ...candidate, match: { gluten: "unknown", lactose: "confirmed" } }],
      constraints: {
        ...result.constraints,
        hard: [{ attribute: "gluten" }, ...result.constraints.hard],
      },
    }),
  );
  expect(output).toContain("Required Gluten free, Lactose free");
  expect(output).toContain("Gluten free · Unknown");
  expect(output).toContain("Lactose free · Confirmed");
});

test("no raw unit code, country code or attribute key is in the visible text", async () => {
  for (const name of ["results", "no-quantity"]) {
    const result = SearchResultSchema.parse(await fixture(name));
    const output = visible(renderSearchResults(result));
    for (const raw of [
      /\bCT\b/,
      /\bLTR\b/,
      /\bfi\b/i,
      /countryOfOrigin/,
      /packagingMaterial/,
      /returnableGlass/,
      /free_from/,
      /invented_drinks/,
      /soft:/,
    ])
      expect(output).not.toMatch(raw);
  }
});

test("known match and converted quantity are shown", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  const candidate = result.candidates.find((item) => item.match["lactose"] === "confirmed");
  if (!candidate) throw new Error("Expected a confirmed candidate");
  const output = visible(renderSearchResults({ ...result, candidates: [candidate] }));
  expect(output).toContain("Lactose free · Confirmed");
  expect(output).toContain("Order 4 packs");
  expect(output).toContain("Equals 48 litres");
  expect(output).toMatch(/Delivery reliability 97\s?% of ordered quantity delivered/);
  expect(output).toContain("Product ID invented_sunberry_juice");
});

test("the empty state says what to change in the request", () => {
  expect(visible(renderNoResults())).toContain("fewer required constraints");
});

test("Finnish names the constraints and the country in Finnish", async () => {
  const result = SearchResultSchema.parse(await fixture("results"));
  setLang("fi");
  try {
    const output = visible(renderSearchResults(result));
    expect(output).toContain("Laktoositon");
    expect(output).toContain("Alkuperämaa: Suomi");
    expect(output).toContain("2 tuotetta löytyi");
  } finally {
    setLang("en");
  }
});
