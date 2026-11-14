import { expect, test } from "bun:test";
import { ok } from "@app/kernel";
import { lazyCatalog } from "../application/catalog.ts";
import { createCatalog } from "../domain/catalog.ts";
import { toOrderQuantity } from "../domain/quantity.ts";
import { defaultDataDir, loadProductFile } from "../infra/product-file.ts";
import { createApi } from "./index.ts";

const app = createApi({
  catalog: lazyCatalog(async () => createCatalog(await loadProductFile(defaultDataDir()))),
  mandates: { current: async () => ok(null) },
});

// The request of issue #13 acceptance 7, against the tracked data files. Runs first, so it measures the load.
test("the real data file yields lactose-free maito candidates in sales units", async () => {
  Bun.gc(true);
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const response = await app.handle(
    new Request("http://localhost/catalog/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        terms: ["maito"],
        hard: [{ attribute: "lactose", is: "free_from" }],
        soft: [],
        quantity: { value: 1000, unit: "LTR" },
        deliverBy: "2026-11-16",
        paymentTerms: "invoice",
      }),
    }),
  );
  const firstRequestMs = Math.round(performance.now() - started);
  Bun.gc(true);
  const rssDeltaMb = Math.round((process.memoryUsage().rss - rssBefore) / 2 ** 20);
  console.log(`catalog index: first request ${firstRequestMs} ms, RSS +${rssDeltaMb} MB`);
  expect(response.status).toBe(200);
  const body: { candidates: { match: Record<string, string>; orderQuantity: unknown }[] } =
    await response.json();
  expect(body.candidates.length).toBeGreaterThan(0);
  expect(body.candidates.every((candidate) => candidate.match["lactose"] !== "contradicted")).toBe(
    true,
  );
  expect(body.candidates).toContainEqual(
    expect.objectContaining({
      productId: "464306",
      match: { lactose: "confirmed" },
      orderQuantity: { value: 1000, unit: "ST" },
      equals: { value: 1000, unit: "LTR" },
    }),
  );
}, 30_000);

test("weight and case products of the real data convert to their own sales units", async () => {
  const cases = [
    { productId: "461587", requested: 44, orderQuantity: { value: 44, unit: "KG" }, equals: 44 },
    { productId: "460916", requested: 10, orderQuantity: { value: 10, unit: "KG" }, equals: 10 },
    {
      productId: "461411",
      requested: 15.68,
      orderQuantity: { value: 16.8, unit: "KG" },
      equals: 16.8,
    },
    { productId: "460675", requested: 20, orderQuantity: { value: 20, unit: "KG" }, equals: 20 },
    { productId: "460301", requested: 6, orderQuantity: { value: 1, unit: "CS" }, equals: 6 },
  ];
  const response = await app.handle(
    new Request("http://localhost/catalog/facts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productIds: cases.map((entry) => entry.productId), hard: [] }),
    }),
  );
  const body: {
    products: {
      productId: string;
      salesUnit: string;
      allowedLotSize: number;
      perSalesUnit: { value: number; unit: string } | null;
    }[];
  } = await response.json();
  const actual = body.products.map((product) => {
    const requested = cases.find((entry) => entry.productId === product.productId)?.requested ?? 0;
    const { orderQuantity, equals } = toOrderQuantity({ value: requested, unit: "KGM" }, product);
    return { productId: product.productId, orderQuantity, equals };
  });
  expect(actual).toEqual(
    cases.map(({ productId, orderQuantity, equals }) => ({
      productId,
      orderQuantity,
      equals: { value: equals, unit: "KGM" },
    })),
  );
});
