import { describe, expect, test } from "bun:test";
import type { SearchRequest } from "@app/contract";
import { type CatalogProduct, createCatalog, parseTerms } from "./catalog.ts";

const product = (productId: string, overrides: Partial<CatalogProduct> = {}): CatalogProduct => ({
  productId,
  gtin: null,
  name: productId,
  searchText: productId,
  category: "10400",
  salesUnit: "ST",
  allowedLotSize: 1,
  perSalesUnit: null,
  countryOfOrigin: null,
  deliveryReliability: null,
  co2PerKg: null,
  claims: new Set(),
  substitutes: [],
  ...overrides,
});

const request = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({
  terms: ["maito"],
  hard: [],
  soft: [],
  quantity: { value: 1, unit: "LTR" },
  deliverBy: "2026-11-16",
  paymentTerms: "invoice",
  ...overrides,
});

const ids = (catalogProducts: CatalogProduct[], searchRequest: SearchRequest) =>
  createCatalog(catalogProducts)
    .searchCatalog(searchRequest)
    .map((candidate) => candidate.productId);

describe("search ranking", () => {
  test("a term matches inside a compound word and every word of a term must match", () => {
    const products = [
      product("a", { searchText: "kevytmaitojuoma 1 l laktoositon" }),
      product("b", { searchText: "lättmjölk" }),
      product("c", { searchText: "maito luomu" }),
    ];
    expect(ids(products, request())).toEqual(["a", "c"]);
    expect(ids(products, request({ terms: ["Maito Luomu"] }))).toEqual(["c"]);
    expect(ids(products, request({ terms: ["mjölk", "luomu"] }))).toEqual(["b", "c"]);
  });

  test("confirmed hard matches rank first, then soft matches, then matched terms, then reliability", () => {
    const products = [
      product("unknown-fi", { searchText: "maito", countryOfOrigin: "fi", deliveryReliability: 1 }),
      product("confirmed-se", {
        searchText: "maito",
        countryOfOrigin: "se",
        claims: new Set(["FREE_FROM_LACTOSE"]),
      }),
      product("unknown-se-both", { searchText: "maito milk", countryOfOrigin: "se" }),
      product("unknown-se-reliable", {
        searchText: "maito",
        countryOfOrigin: "se",
        deliveryReliability: 0.9,
      }),
      product("unknown-se", { searchText: "maito", countryOfOrigin: "se" }),
    ];
    expect(
      ids(
        products,
        request({
          terms: ["maito", "milk"],
          hard: [{ attribute: "lactose", is: "free_from" }],
          soft: [{ attribute: "countryOfOrigin", prefer: "FI" }],
        }),
      ),
    ).toEqual([
      "confirmed-se",
      "unknown-fi",
      "unknown-se-both",
      "unknown-se-reliable",
      "unknown-se",
    ]);
  });

  test("returns at most 20 candidates", () => {
    const products = Array.from({ length: 25 }, (_, index) => product(`maito-${index}`));
    expect(createCatalog(products).searchCatalog(request())).toHaveLength(20);
  });

  test("blank terms give no candidates and parse as EMPTY_TERMS", () => {
    expect(ids([product("maito")], request({ terms: [" "] }))).toEqual([]);
    expect(parseTerms([" ", ""])).toEqual({ ok: false, error: "EMPTY_TERMS" });
  });
});

test("getSubstitutes lists the substitution pairs and nothing for an unknown id", () => {
  const catalog = createCatalog([product("a", { substitutes: ["b", "c"] })]);
  expect(catalog.getSubstitutes("a")).toEqual(["b", "c"]);
  expect(catalog.getSubstitutes("x")).toEqual([]);
});
