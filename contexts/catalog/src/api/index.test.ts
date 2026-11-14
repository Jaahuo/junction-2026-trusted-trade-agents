import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HardConstraint, SearchResultSchema } from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { Elysia } from "elysia";
import {
  type AvailabilitySource,
  type CatalogDeps,
  type CurrentMandate,
  lazyCatalog,
  type MandateSource,
  SEARCH_POOL,
} from "../application/catalog.ts";
import { type CatalogProduct, createCatalog } from "../domain/catalog.ts";
import { MAX_QUANTITY } from "../domain/quantity.ts";
import { edenMandateSource } from "../infra/mandate-client.ts";
import { DATA_FILES, loadProductFile } from "../infra/product-file.ts";
import { createApi } from "./index.ts";

const product = (overrides: Partial<CatalogProduct> & { productId: string }): CatalogProduct => ({
  gtin: null,
  name: `milk ${overrides.productId}`,
  searchText: `milk ${overrides.productId}\nmaito`,
  category: "T-CAT",
  salesUnit: "KI",
  allowedLotSize: 1,
  perSalesUnit: { value: 10, unit: "LTR" },
  countryOfOrigin: "fi",
  deliveryReliability: 0.95,
  co2PerKg: 2.2,
  claims: new Set(["FREE_FROM_LACTOSE"]),
  substitutes: [],
  ...overrides,
});

const products = [
  product({
    productId: "free",
    name: "lactose-free milk",
    searchText: "lactose-free milk\nmaito",
    substitutes: ["low", "plain"],
    gtin: "0000000000042",
  }),
  product({ productId: "low", claims: new Set(["LOW_LACTOSE"]) }),
  product({
    productId: "plain",
    claims: new Set(),
    perSalesUnit: null,
    deliveryReliability: null,
    co2PerKg: null,
    countryOfOrigin: "se",
  }),
  product({ productId: "bread", name: "bread", searchText: "bread\nleipä" }),
];

const noMandate: MandateSource = { current: async () => ok(null) };
const fakeMandate = (value: Result<CurrentMandate | null, "UPSTREAM_FAILED">): MandateSource => ({
  current: async () => value,
});

const allDeliverable: AvailabilitySource = {
  deliverable: async (_deliverBy, productIds) => ok(new Set(productIds)),
};
const onlyDeliverable = (...deliverable: string[]) => {
  const calls: { deliverBy: string; productIds: readonly string[] }[] = [];
  const source: AvailabilitySource = {
    deliverable: async (deliverBy, productIds) => {
      calls.push({ deliverBy, productIds });
      return ok(new Set(deliverable));
    },
  };
  return { source, calls };
};

const deps = (overrides: Partial<CatalogDeps> = {}): CatalogDeps => ({
  catalog: async () => ok(createCatalog(products)),
  mandates: noMandate,
  availability: allDeliverable,
  ...overrides,
});

const searchBody = {
  terms: ["milk"],
  hard: [] as HardConstraint[],
  soft: [] as { attribute: string; prefer: string }[],
  quantity: { value: 1000, unit: "LTR" },
  deliverBy: "2026-11-16",
  paymentTerms: "invoice",
};

const post = async (
  app: { handle: (request: Request) => Promise<Response> },
  path: string,
  body: unknown,
) => {
  const response = await app.handle(
    new Request(`http://localhost/catalog${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json: unknown = await response.json();
  return { status: response.status, body: json };
};

const ids = (body: unknown): unknown =>
  typeof body === "object" &&
  body !== null &&
  "candidates" in body &&
  Array.isArray(body.candidates)
    ? body.candidates.map((candidate: { productId: string }) => candidate.productId)
    : body;

const inProcess = (app: { handle: (request: Request) => Promise<Response> }) =>
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => app.handle(new Request(input, init)),
    { preconnect: fetch.preconnect },
  );

describe("POST /catalog/search availability", () => {
  test("a product that cannot be delivered by deliverBy is not a candidate, and dropped counts it", async () => {
    const { source, calls } = onlyDeliverable("free", "plain");
    const { status, body } = await post(
      createApi(deps({ availability: source })),
      "/search",
      searchBody,
    );
    expect(status).toBe(200);
    expect(ids(body)).toEqual(["free", "plain"]);
    expect(SearchResultSchema.parse(body).availability).toEqual({ checked: true, dropped: 1 });
    expect(calls).toEqual([{ deliverBy: "2026-11-16", productIds: ["free", "low", "plain"] }]);
  });

  test("when nothing is deliverable the candidates are empty and dropped counts every match", async () => {
    const { source } = onlyDeliverable();
    const { body } = await post(createApi(deps({ availability: source })), "/search", searchBody);
    expect(SearchResultSchema.parse(body)).toMatchObject({
      candidates: [],
      availability: { checked: true, dropped: 3 },
    });
  });

  test("a failed availability read answers 200 with the unfiltered candidates and checked false", async () => {
    const failing: AvailabilitySource = { deliverable: async () => err("UPSTREAM_FAILED") };
    const { status, body } = await post(
      createApi(deps({ availability: failing })),
      "/search",
      searchBody,
    );
    expect(status).toBe(200);
    expect(ids(body)).toEqual(["free", "low", "plain"]);
    expect(SearchResultSchema.parse(body).availability).toEqual({ checked: false, dropped: 0 });
  });

  test("a search with no match does not read availability", async () => {
    const { source, calls } = onlyDeliverable();
    const { body } = await post(createApi(deps({ availability: source })), "/search", {
      ...searchBody,
      terms: ["T-NO-SUCH-WORD"],
    });
    expect(SearchResultSchema.parse(body)).toMatchObject({
      candidates: [],
      availability: { checked: true, dropped: 0 },
    });
    expect(calls).toEqual([]);
  });

  test("lower-ranked matches fill the 20 places that undeliverable matches leave, from a pool of SEARCH_POOL", async () => {
    const many = Array.from({ length: SEARCH_POOL + 5 }, (_, index) =>
      product({ productId: `m${String(index).padStart(3, "0")}` }),
    );
    const ranked = many.map((entry) => entry.productId);
    // The 25 best matches cannot be delivered; the next 35 of the pool can.
    const { source, calls } = onlyDeliverable(...ranked.slice(25));
    const { body } = await post(
      createApi(deps({ catalog: async () => ok(createCatalog(many)), availability: source })),
      "/search",
      searchBody,
    );
    expect(calls[0]?.productIds).toEqual(ranked.slice(0, SEARCH_POOL));
    expect(ids(body)).toEqual(ranked.slice(25, 45));
    expect(SearchResultSchema.parse(body).availability).toEqual({ checked: true, dropped: 25 });
  });
});

describe("POST /catalog/search", () => {
  test("search merges the mandate's standing constraints and returns them and the mandate id and version", async () => {
    const mandate = fakeMandate(
      ok({
        id: "mdt_1",
        version: 3,
        standingConstraints: {
          hard: [{ attribute: "lactose", is: "free_from" }],
          soft: [{ attribute: "countryOfOrigin", prefer: "fi" }],
        },
      }),
    );
    const { status, body } = await post(
      createApi(deps({ mandates: mandate })),
      "/search",
      searchBody,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      constraints: {
        hard: [{ attribute: "lactose", is: "free_from" }],
        soft: [{ attribute: "countryOfOrigin", prefer: "fi" }],
      },
      mandate: { id: "mdt_1", version: 3 },
    });
    expect(ids(body)).toEqual(["free", "plain"]);
  });

  test("rejects unsupported request soft attributes before either upstream call", async () => {
    let calls = 0;
    const app = createApi(
      deps({
        mandates: {
          current: async () => {
            calls += 1;
            return ok(null);
          },
        },
        catalog: async () => {
          calls += 1;
          return ok(createCatalog(products));
        },
      }),
    );
    const result = await post(app, "/search", {
      ...searchBody,
      soft: [{ attribute: "brand", prefer: "example" }],
    });
    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "soft.attribute: supported attributes are countryOfOrigin and category.",
        },
      },
    });
    expect(calls).toBe(0);
  });

  test("rejects unsupported standing soft attributes before loading the catalog", async () => {
    let loads = 0;
    const app = createApi(
      deps({
        mandates: fakeMandate(
          ok({
            id: "mdt_bad",
            version: 1,
            standingConstraints: { hard: [], soft: [{ attribute: "brand", prefer: "example" }] },
          }),
        ),
        catalog: async () => {
          loads += 1;
          return ok(createCatalog(products));
        },
      }),
    );
    const result = await post(app, "/search", {
      ...searchBody,
      soft: [{ attribute: "category", prefer: "T-CAT" }],
    });
    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "soft.attribute: supported attributes are countryOfOrigin and category.",
        },
      },
    });
    expect(loads).toBe(0);
  });

  test("supported soft preferences are echoed only when confirmed and never exclude products", async () => {
    const catalogProducts = [
      product({ productId: "first", category: "T-CAT / Fresh", countryOfOrigin: "fi" }),
      product({ productId: "second", category: "Other", countryOfOrigin: "se" }),
      product({ productId: "unknown", category: "Unmatched", countryOfOrigin: null }),
    ];
    const soft = [
      { attribute: "countryOfOrigin", prefer: "FI" },
      { attribute: "countryOfOrigin", prefer: "SE" },
      { attribute: "category", prefer: "T-CAT / Fresh" },
      { attribute: "category", prefer: "Other" },
    ];
    const { status, body } = await post(
      createApi(deps({ catalog: async () => ok(createCatalog(catalogProducts)) })),
      "/search",
      { ...searchBody, soft },
    );
    expect(status).toBe(200);
    const result = SearchResultSchema.parse(body);
    expect(
      Object.fromEntries(result.candidates.map(({ productId, match }) => [productId, match])),
    ).toEqual({
      first: {
        "soft:countryOfOrigin:fi": "confirmed",
        "soft:category:t-cat%20%2F%20fresh": "confirmed",
      },
      second: {
        "soft:countryOfOrigin:se": "confirmed",
        "soft:category:other": "confirmed",
      },
      unknown: {},
    });
  });

  test("a 501 or 404 from mandates gives mandate null and no merge", async () => {
    for (const [code, errorCode] of [
      [404, "NOT_FOUND"],
      [501, "NOT_IMPLEMENTED"],
    ] as const) {
      const mandates = new Elysia().get("/api/mandates/current", ({ status }) =>
        status(code, { error: { code: errorCode, message: "none" } }),
      );
      const source = edenMandateSource(() => "http://localhost/api", inProcess(mandates));
      expect(await source.current()).toEqual(ok(null));
      const { status, body } = await post(
        createApi(deps({ mandates: source })),
        "/search",
        searchBody,
      );
      expect({ code, status, body }).toMatchObject({
        code,
        status: 200,
        body: { constraints: { hard: [], soft: [] }, mandate: null },
      });
      expect(ids(body)).toEqual(["free", "low", "plain"]);
    }
  });

  test("any other mandates failure gives 502 UPSTREAM_FAILED", async () => {
    const mandates = new Elysia().get("/api/mandates/current", ({ status }) =>
      status(500, { error: { code: "UPSTREAM_FAILED", message: "down" } }),
    );
    const source = edenMandateSource(() => "http://localhost/api", inProcess(mandates));
    expect(await source.current()).toEqual(err("UPSTREAM_FAILED"));
    const { status, body } = await post(
      createApi(deps({ mandates: fakeMandate(err("UPSTREAM_FAILED")) })),
      "/search",
      searchBody,
    );
    expect({ status, body }).toMatchObject({
      status: 502,
      body: { error: { code: "UPSTREAM_FAILED" } },
    });
  });

  test("a 200 mandates body that fails the stored mandate schema gives 502 UPSTREAM_FAILED", async () => {
    const valid = {
      mandateId: "T-MANDATE",
      version: 1,
      iss: "T-CUSTOMER",
      agent: "T-AGENT",
      signedBy: "T-ACCOUNT",
      iat: 1,
      exp: 2,
    };
    for (const answer of [{}, { mandate: valid, jws: null, status: "active" }]) {
      const mandates = new Elysia().get("/api/mandates/current", () => answer);
      const source = edenMandateSource(() => "http://localhost/api", inProcess(mandates));
      expect(await source.current()).toEqual(err("UPSTREAM_FAILED"));
      const { status, body } = await post(
        createApi(deps({ mandates: source })),
        "/search",
        searchBody,
      );
      expect({ answer, status, body }).toEqual({
        answer,
        status: 502,
        body: {
          error: { code: "UPSTREAM_FAILED", message: "The current mandate could not be read." },
        },
      });
    }
  });

  test("search excludes contradicted products and returns orderQuantity, equals, reliability and CO2 or null", async () => {
    const { status, body } = await post(createApi(deps()), "/search", {
      ...searchBody,
      hard: [{ attribute: "lactose", is: "free_from" }],
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      candidates: [
        {
          productId: "free",
          gtin: "0000000000042",
          name: "lactose-free milk",
          category: "T-CAT",
          match: { lactose: "confirmed" },
          orderQuantity: { value: 100, unit: "KI" },
          equals: { value: 1000, unit: "LTR" },
          deliveryReliability: 0.95,
          co2PerKg: 2.2,
          substitutes: ["low", "plain"],
        },
        {
          productId: "plain",
          gtin: null,
          name: "milk plain",
          category: "T-CAT",
          match: { lactose: "unknown" },
          orderQuantity: null,
          quantityReason: "Sales unit conversion is unavailable.",
          equals: null,
          deliveryReliability: null,
          co2PerKg: null,
          substitutes: [],
        },
      ],
      constraints: { hard: [{ attribute: "lactose", is: "free_from" }], soft: [] },
      mandate: null,
      availability: { checked: true, dropped: 0 },
    });
  });

  test("two parallel first requests load the index once", async () => {
    let loads = 0;
    const catalog = lazyCatalog(async () => {
      loads += 1;
      await Bun.sleep(10);
      return createCatalog(products);
    });
    const app = createApi(deps({ catalog }));
    const [first, second] = await Promise.all([
      post(app, "/search", searchBody),
      post(app, "/facts", { productIds: ["free"], hard: [] }),
    ]);
    expect([first.status, second.status, loads]).toEqual([200, 200, 1]);
    await post(app, "/search", searchBody);
    expect(loads).toBe(1);
  });

  test("a failed index load answers 502 with the error envelope and is retried on the next request", async () => {
    let loads = 0;
    const catalog = lazyCatalog(async () => {
      loads += 1;
      if (loads <= 2) throw new Error("disk not ready");
      return createCatalog(products);
    });
    const app = createApi(deps({ catalog }));
    const failed = [
      await post(app, "/search", searchBody),
      await post(app, "/facts", { productIds: ["free"], hard: [] }),
    ];
    expect(failed).toEqual([
      {
        status: 502,
        body: {
          error: { code: "UPSTREAM_FAILED", message: "The product index could not be loaded." },
        },
      },
      {
        status: 502,
        body: {
          error: { code: "UPSTREAM_FAILED", message: "The product index could not be loaded." },
        },
      },
    ]);
    expect((await post(app, "/facts", { productIds: ["free"], hard: [] })).status).toBe(200);
    expect(loads).toBe(3);
  });

  test("a product file with no valid record answers 502 and loads once it is repaired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-repair-"));
    try {
      await Bun.write(join(dir, DATA_FILES.reliability), "productId,deliveryReliability\r\n");
      await Bun.write(join(dir, DATA_FILES.co2), "productId,AVG kg CO2-eq/kg\r\n");
      await Bun.write(join(dir, DATA_FILES.products), JSON.stringify([{ id: "T-BAD" }]));
      const app = createApi(
        deps({ catalog: lazyCatalog(async () => createCatalog(await loadProductFile(dir))) }),
      );
      const broken = await post(app, "/search", searchBody);
      expect(broken).toEqual({
        status: 502,
        body: {
          error: { code: "UPSTREAM_FAILED", message: "The product index could not be loaded." },
        },
      });
      const repaired = {
        id: "T-GOOD",
        salesUnit: "ST",
        baseUnit: "ST",
        category: "T-CAT",
        allowedLotSize: 1,
        units: [{ unitId: "ST", sizeInBaseUnits: 1 }],
        synkkaData: { names: [{ value: "Test milk", language: "en" }] },
      };
      await Bun.write(join(dir, DATA_FILES.products), JSON.stringify([repaired]));
      const fixed = await post(app, "/search", searchBody);
      expect({ status: fixed.status, ids: ids(fixed.body) }).toEqual({
        status: 200,
        ids: ["T-GOOD"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty terms gives 400", async () => {
    let loads = 0;
    const app = createApi(
      deps({
        catalog: async () => {
          loads += 1;
          return ok(createCatalog(products));
        },
      }),
    );
    for (const terms of [[], ["  "]]) {
      const { status, body } = await post(app, "/search", { ...searchBody, terms });
      expect({ terms, status, body }).toMatchObject({
        terms,
        status: 400,
        body: { error: { code: "BAD_REQUEST", message: expect.any(String) } },
      });
    }
    expect(loads).toBe(0);
  });

  test("a zero, negative or huge quantity gives 400", async () => {
    for (const value of [0, -5, 1e303]) {
      const { status, body } = await post(createApi(deps()), "/search", {
        ...searchBody,
        quantity: { value, unit: "LTR" },
      });
      expect({ value, status, body }).toEqual({
        value,
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: `quantity.value: must be above 0 and at most ${MAX_QUANTITY}.`,
          },
        },
      });
    }
  });

  test("a mandates base URL that throws gives 502 UPSTREAM_FAILED", async () => {
    const source = edenMandateSource(() => {
      throw new Error("Set PORT or INTERNAL_BASE_URL.");
    });
    expect(await source.current()).toEqual(err("UPSTREAM_FAILED"));
  });

  test("an unknown allergen code gives 400 naming the attribute", async () => {
    for (const attribute of ["unicorn", "AE"]) {
      const { status, body } = await post(createApi(deps()), "/search", {
        ...searchBody,
        hard: [{ attribute, is: "free_from" }],
      });
      expect({ status, body }).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: expect.stringContaining(
              `unsupported hard constraint attribute "${attribute}"`,
            ),
          },
        },
      });
    }
  });

  test("an allergen CONTAINS or MAY_CONTAIN is excluded, FREE_FROM is confirmed, no data is unknown", async () => {
    const eggs = [
      product({ productId: "egg-free", claims: new Set(["FREE_FROM:AE"]) }),
      product({ productId: "egg", claims: new Set(["CONTAINS:AE"]) }),
      product({ productId: "egg-traces", claims: new Set(["MAY_CONTAIN:AE"]) }),
      product({ productId: "egg-no-data", claims: new Set() }),
    ];
    const { status, body } = await post(
      createApi(deps({ catalog: async () => ok(createCatalog(eggs)) })),
      "/search",
      { ...searchBody, hard: [{ attribute: "egg", is: "free_from" }] },
    );
    expect(status).toBe(200);
    expect(SearchResultSchema.parse(body).candidates.map((c) => [c.productId, c.match])).toEqual([
      ["egg-free", { egg: "confirmed" }],
      ["egg-no-data", { egg: "unknown" }],
    ]);
  });
});

describe("POST /catalog/facts", () => {
  test("facts returns substitutes and the match for the given hard constraints; unknown ids are listed", async () => {
    const { status, body } = await post(createApi(deps()), "/facts", {
      productIds: ["free", "low", "missing"],
      hard: [{ attribute: "lactose", is: "free_from" }],
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      products: [
        {
          productId: "free",
          gtin: "0000000000042",
          name: "lactose-free milk",
          category: "T-CAT",
          salesUnit: "KI",
          allowedLotSize: 1,
          perSalesUnit: { value: 10, unit: "LTR" },
          countryOfOrigin: "fi",
          deliveryReliability: 0.95,
          co2PerKg: 2.2,
          match: { lactose: "confirmed" },
          substitutes: ["low", "plain"],
        },
        expect.objectContaining({ productId: "low", match: { lactose: "contradicted" } }),
      ],
      unknown: ["missing"],
    });
  });

  test("facts without hard constraints gives an empty match", async () => {
    const { body } = await post(createApi(deps()), "/facts", { productIds: ["plain"], hard: [] });
    expect(body).toMatchObject({ products: [{ productId: "plain", match: {} }], unknown: [] });
  });
});
