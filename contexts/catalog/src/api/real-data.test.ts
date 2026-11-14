import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DemoProductsSchema, SearchResultSchema } from "@app/contract";
import { ok } from "@app/kernel";
import { lazyCatalog } from "../application/catalog.ts";
import { createCatalog } from "../domain/catalog.ts";
import { defaultDataDir, loadProductFile } from "../infra/product-file.ts";
import { createApi } from "./index.ts";

// Smoke test of the tracked data files: general invariants only, no dataset values (team rules R-23).
const load = lazyCatalog(async () => createCatalog(await loadProductFile(defaultDataDir())));
const app = createApi({ catalog: load, mandates: { current: async () => ok(null) } });

const requested = { value: 1000, unit: "LTR" };

// The request of issue #13 acceptance 7. Runs first, so it measures the load.
test("the acceptance request yields candidates that cover the requested quantity and contradict nothing", async () => {
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
        quantity: requested,
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
  const { candidates } = SearchResultSchema.parse(await response.json());
  expect(candidates.length).toBeGreaterThan(0);
  for (const candidate of candidates) {
    expect(candidate.match["lactose"]).not.toBe("contradicted");
    if (candidate.orderQuantity === null) continue;
    expect(candidate.equals?.unit).toBe(requested.unit);
    expect(candidate.equals?.value ?? 0).toBeGreaterThanOrEqual(requested.value);
  }
}, 30_000);

test("the demo milk is found by its literal English name", async () => {
  const response = await app.handle(
    new Request("http://localhost/catalog/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        terms: ["milk"],
        hard: [{ attribute: "lactose", is: "free_from" }],
        soft: [],
        quantity: requested,
        deliverBy: "2026-11-16",
        paymentTerms: "invoice",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const { candidates } = SearchResultSchema.parse(await response.json());
  const demoFile = Bun.file(resolve(defaultDataDir(), "demo-products.json"));
  const demo = DemoProductsSchema.parse(await demoFile.json());
  expect(candidates.map((candidate) => candidate.productId)).toContain(demo.s2.productId);
}, 30_000);

test("every product sold by weight has its volume per sales unit in KGM", async () => {
  const products = await loadProductFile(defaultDataDir());
  const weighed = products.filter(
    (product) => product.salesUnit === "KG" && product.perSalesUnit !== null,
  );
  expect(weighed.length).toBeGreaterThan(0);
  expect(weighed.filter((product) => product.perSalesUnit?.unit !== "KGM")).toEqual([]);
});
