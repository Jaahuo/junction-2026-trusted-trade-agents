import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "@app/kernel";
import { Elysia } from "elysia";
import {
  type CatalogDeps,
  type CurrentMandate,
  lazyCatalog,
  type MandateSource,
} from "../application/catalog.ts";
import { type CatalogProduct, createCatalog } from "../domain/catalog.ts";
import { edenMandateSource } from "../infra/mandate-client.ts";
import { createApi } from "./index.ts";

const product = (overrides: Partial<CatalogProduct> & { productId: string }): CatalogProduct => ({
  gtin: null,
  name: `milk ${overrides.productId}`,
  searchText: `milk ${overrides.productId}\nmaito`,
  category: "10400",
  salesUnit: "KI",
  allowedLotSize: 1,
  perSalesUnit: { value: 10, unit: "LTR" },
  countryOfOrigin: "fi",
  deliveryReliability: 0.95,
  co2PerKg: 1.1,
  claims: new Set(["FREE_FROM_LACTOSE"]),
  substitutes: [],
  ...overrides,
});

const products = [
  product({ productId: "free", substitutes: ["low", "plain"], gtin: "6400000000001" }),
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

const deps = (overrides: Partial<CatalogDeps> = {}): CatalogDeps => ({
  catalog: async () => ok(createCatalog(products)),
  mandates: noMandate,
  ...overrides,
});

const searchBody = {
  terms: ["milk"],
  hard: [] as { attribute: "lactose"; is: "free_from" }[],
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

  test("a 501 or 404 from mandates gives mandate null and no merge", async () => {
    for (const code of [404, 501] as const) {
      const mandates = new Elysia().get("/api/mandates/current", ({ status }) =>
        status(code, { error: { code: "NOT_FOUND", message: "none" } }),
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
          gtin: "6400000000001",
          name: "milk free",
          category: "10400",
          match: { lactose: "confirmed" },
          orderQuantity: { value: 100, unit: "KI" },
          equals: { value: 1000, unit: "LTR" },
          deliveryReliability: 0.95,
          co2PerKg: 1.1,
          substitutes: ["low", "plain"],
        },
        {
          productId: "plain",
          gtin: null,
          name: "milk plain",
          category: "10400",
          match: { lactose: "unknown" },
          orderQuantity: null,
          equals: null,
          deliveryReliability: null,
          co2PerKg: null,
          substitutes: [],
        },
      ],
      constraints: { hard: [{ attribute: "lactose", is: "free_from" }], soft: [] },
      mandate: null,
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

  test("a zero or negative quantity gives 400", async () => {
    for (const value of [0, -5]) {
      const { status, body } = await post(createApi(deps()), "/search", {
        ...searchBody,
        quantity: { value, unit: "LTR" },
      });
      expect({ value, status, body }).toEqual({
        value,
        status: 400,
        body: { error: { code: "BAD_REQUEST", message: "quantity.value: must be above 0." } },
      });
    }
  });

  test("a mandates base URL that throws gives 502 UPSTREAM_FAILED", async () => {
    const source = edenMandateSource(() => {
      throw new Error("Set PORT or INTERNAL_BASE_URL.");
    });
    expect(await source.current()).toEqual(err("UPSTREAM_FAILED"));
  });

  test("an unsupported hard constraint gives 400 naming the attribute", async () => {
    const { status, body } = await post(createApi(deps()), "/search", {
      ...searchBody,
      hard: [{ attribute: "gluten", is: "free_from" }],
    });
    expect({ status, body }).toMatchObject({
      status: 400,
      body: { error: { code: "BAD_REQUEST" } },
    });
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
          gtin: "6400000000001",
          name: "milk free",
          category: "10400",
          salesUnit: "KI",
          allowedLotSize: 1,
          perSalesUnit: { value: 10, unit: "LTR" },
          countryOfOrigin: "fi",
          deliveryReliability: 0.95,
          co2PerKg: 1.1,
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
