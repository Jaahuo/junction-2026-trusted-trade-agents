import { describe, expect, test } from "bun:test";
import type { SearchRequest } from "@app/contract";
import { type CatalogProduct, createCatalog, parseTerms } from "./catalog.ts";

const product = (productId: string, overrides: Partial<CatalogProduct> = {}): CatalogProduct => ({
  productId,
  gtin: null,
  name: productId,
  searchText: productId,
  category: "T-CAT",
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
  test("matches whole Unicode words, with AND within a line and OR across terms", () => {
    const products = [
      product("compound", { searchText: "testimaitojuoma milkshake" }),
      product("swedish", { searchText: "lättmjölk" }),
      product("organic", { searchText: "maito luomu" }),
      product("languages", { searchText: "maito\norganic milk" }),
    ];
    expect(ids(products, request())).toEqual(["languages", "organic"]);
    expect(ids(products, request({ terms: ["Maito Luomu"] }))).toEqual(["organic"]);
    expect(
      ids(
        [product("cross", { searchText: "maito\norganic" })],
        request({ terms: ["maito organic"] }),
      ),
    ).toEqual([]);
    expect(ids(products, request({ terms: ["milk"] }))).toEqual(["languages", "organic"]);
    expect(ids(products, request({ terms: ["mjölk", "luomu"] }))).toEqual(["organic"]);
  });

  test("milk and maito match as whole-word equivalents on the same name line", () => {
    const products = [
      product("english", { searchText: "kuumamaitojuoma\nfresh milk" }),
      product("finnish", { searchText: "tuore maito" }),
      product("compound", { searchText: "kuumamaitojuoma\nmilkshake" }),
      product("negated", { searchText: "milk-free drink\nfree from milk" }),
      product("cross", { searchText: "milk\norganic" }),
    ];
    expect(ids(products, request({ terms: ["maito"] }))).toEqual(["cross", "english", "finnish"]);
    expect(ids(products, request({ terms: ["milk"] }))).toEqual(["cross", "english", "finnish"]);
    expect(ids(products, request({ terms: ["fresh maito"] }))).toEqual(["english"]);
    expect(ids(products, request({ terms: ["tuore milk"] }))).toEqual(["finnish"]);
    expect(ids(products, request({ terms: ["organic maito"] }))).toEqual([]);
  });

  test("a hyphenated term matches names that write the words apart", () => {
    const products = [
      product("apart", { searchText: "test milk 1 l lactose free uht" }),
      product("cheese", { searchText: "test lactose-free cheese 200 g" }),
    ];
    expect(ids(products, request({ terms: ["lactose-free milk"] }))).toEqual(["apart"]);
  });

  test("a hyphenated name still matches the hyphenated term", () => {
    const products = [product("joined", { searchText: "test lactose‑free milk drink 1 l" })];
    expect(ids(products, request({ terms: ["lactose-free milk"] }))).toEqual(["joined"]);
    expect(parseTerms(["Lactose-free  milk"])).toEqual({
      ok: true,
      value: [["lactose", "free", "milk"]],
    });
  });

  test("ranks hard matches, soft matches, matched terms, then reliability", () => {
    const products = [
      product("unknown-fi", { searchText: "maito", countryOfOrigin: "fi", deliveryReliability: 1 }),
      product("confirmed-se", {
        searchText: "maito",
        countryOfOrigin: "se",
        claims: new Set(["FREE_FROM_LACTOSE"]),
      }),
      product("unknown-se-both", { searchText: "maito luomu", countryOfOrigin: "se" }),
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
          terms: ["maito", "luomu"],
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

  test("rejects negated occurrences but accepts lactose-free and separate positive occurrences", () => {
    const products = [
      product("free", { searchText: "milk-free chocolate" }),
      product("from", { searchText: "free from milk" }),
      product("finnish", { searchText: "maidoton suklaa" }),
      product("lactose", { searchText: "lactose-free milk" }),
      product("both", { searchText: "milk-free flavor milk" }),
    ];
    expect(ids(products, request({ terms: ["milk"] }))).toEqual(["both", "lactose"]);
    expect(ids(products, request({ terms: ["maito"] }))).toEqual(["both", "lactose"]);
  });

  test("ranks drinkable milk above chocolate and powder and conversion before reliability", () => {
    const products = [
      product("chocolate", { searchText: "milk chocolate", deliveryReliability: 1 }),
      product("powder", { searchText: "milk powder", deliveryReliability: 1 }),
      product("unknown-volume", { searchText: "milk uht", deliveryReliability: 1 }),
      product("liquid", {
        searchText: "milk lactose free uht",
        perSalesUnit: { value: 1, unit: "LTR" },
      }),
    ];
    const results = createCatalog(products).searchCatalog(request({ terms: ["milk"] }));
    expect(results.map((candidate) => candidate.productId)).toEqual([
      "liquid",
      "unknown-volume",
      "chocolate",
      "powder",
    ]);
    expect(results[0]?.orderQuantity).toEqual({ value: 1, unit: "ST" });
    expect(results[1]?.orderQuantity).toBeNull();
    expect(results[1]?.quantityReason).toBeTruthy();
  });

  test("ranks liquid milk above other heads even across translations and adjectives", () => {
    const liquids = [
      "branded lactose free milk uht\nbranded maito laktoositon uht",
      "full cream lactose free milk uht\nmaito laktoositon",
      "lactose free full cream milk\nmaito laktoositon",
      "fresh lactose free milk\nmaito laktoositon",
      "lactose free milk uht\nmaito laktoositon",
    ].map((searchText, index) =>
      product(`liquid-${index}`, { searchText, perSalesUnit: { value: 1, unit: "LTR" } }),
    );
    const others = [
      product("cream", {
        searchText: "lactose free milk organic cream\nmaito laktoositon",
        perSalesUnit: { value: 1, unit: "LTR" },
        deliveryReliability: 1,
      }),
      product("translated-powder", {
        searchText: "lactose free milk\nmaito laktoositon\njauhe",
        perSalesUnit: { value: 1, unit: "LTR" },
        deliveryReliability: 1,
      }),
      product("chocolate", {
        searchText: "lactose free milk organic chocolate\nmaito laktoositon suklaa",
        perSalesUnit: { value: 1, unit: "LTR" },
        deliveryReliability: 1,
      }),
    ];
    const catalog = createCatalog([...others, ...liquids]);
    for (const term of ["milk", "maito", "lactose-free milk"]) {
      const results = catalog.searchCatalog(request({ terms: [term] }));
      expect(results.slice(0, 5).map((candidate) => candidate.productId)).toEqual(
        liquids.map((candidate) => candidate.productId),
      );
      expect(
        results
          .slice(0, 5)
          .every(
            (candidate) =>
              candidate.orderQuantity !== null && Number.isInteger(candidate.orderQuantity.value),
          ),
      ).toBe(true);
    }
  });

  test("generated brands and adjectives do not change head relevance or word boundaries", () => {
    for (const brand of ["orchard", "meadow"]) {
      for (const adjective of ["fresh", "organic"]) {
        for (const head of ["cream", "chocolate", "powder"]) {
          const products = [
            product("liquid", {
              searchText: `${brand} ${adjective} milk uht\nkuumamaitojuoma`,
              perSalesUnit: { value: 1, unit: "LTR" },
            }),
            product("derived", {
              searchText: `${brand} milk ${adjective} ${head}\nmaito ${head}`,
              perSalesUnit: { value: 1, unit: "LTR" },
              deliveryReliability: 1,
            }),
          ];
          expect(ids(products, request({ terms: ["milk"] }))).toEqual(["liquid", "derived"]);
          expect(ids(products, request({ terms: ["maito"] }))).toEqual(["liquid", "derived"]);
        }
      }
    }
  });

  test("reports only matched soft preferences without changing hard filtering or facts", () => {
    const catalog = createCatalog([
      product("a", { searchText: "milk", countryOfOrigin: "FI/Å" }),
      product("b", { searchText: "milk", countryOfOrigin: "SE" }),
      product("c", { searchText: "milk" }),
    ]);
    const results = catalog.searchCatalog(
      request({
        terms: ["milk"],
        soft: [
          { attribute: "countryOfOrigin", prefer: "FI/Å" },
          { attribute: "countryOfOrigin", prefer: "SE" },
          { attribute: "category", prefer: "T-CAT" },
          { attribute: "unknown", prefer: "value" },
        ],
      }),
    );
    expect(results.map((candidate) => candidate.productId)).toEqual(["a", "b", "c"]);
    expect(results[0]?.match).toEqual({
      "soft:countryOfOrigin:fi%2F%C3%A5": "confirmed",
      "soft:category:t-cat": "confirmed",
    });
    expect(results[1]?.match).toEqual({
      "soft:countryOfOrigin:se": "confirmed",
      "soft:category:t-cat": "confirmed",
    });
    expect(results[2]?.match).toEqual({ "soft:category:t-cat": "confirmed" });
    expect(catalog.facts({ productIds: ["a"], hard: [] }).products[0]?.match).toEqual({});
  });

  test("uses reliability and then stable product id for otherwise equal candidates", () => {
    const products = [
      product("z", { searchText: "milk", deliveryReliability: 0.5 }),
      product("b", { searchText: "milk", deliveryReliability: 0.9 }),
      product("a", { searchText: "milk", deliveryReliability: 0.9 }),
    ];
    expect(ids(products, request({ terms: ["milk"] }))).toEqual(["a", "b", "z"]);
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
