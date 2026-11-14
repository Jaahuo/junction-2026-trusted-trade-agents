import type { DemoProducts } from "../packages/contract/src/index.ts";
import { loadCatalogProducts, readDemoProducts } from "../contexts/catalog/src/api/index.ts";
import { createCatalog } from "../contexts/catalog/src/domain/catalog.ts";
import { closeDb, env, openDb } from "../packages/server-kit/src/index.ts";
import { currentDatabase } from "./runtime.ts";

// Two requests per run, each containing at most 40 product IDs.
const BASE_URL = "https://junction26.valioaimo.fi";

type Availability = {
  productId: string;
  salesBlock: boolean;
  scheduleLines: { availableAmount: number; availableDate?: string | null; salesBlock: boolean }[];
};
type Price = {
  productId: string;
  error: boolean;
  catalogPrice?: { value: number; valueWithTax: number } | null;
  comparisonPrice?: { value: number } | null;
  comparisonUnit?: string | null;
};

/** The scenario 1 chat sentence and the search words an agent sends for it (docs/buyer-agent-prompt.md). */
export const SCENARIO_1 = {
  sentence: "We need 20 litres of whole milk on Monday.",
  terms: ["whole milk"],
} as const;

/**
 * The product the scenario 1 sentence finds first: the catalogue's own ranking with the demo
 * mandate's standing preference for Finnish origin. Scenario 1 places without approval only when
 * this is the S1 product, the one with seeded order history.
 */
export function scenario1TopProduct(
  products: Parameters<typeof createCatalog>[0],
  s1: DemoProducts["s1"],
  date: string,
): string | null {
  const [top] = createCatalog(products).searchCatalog(
    {
      terms: [...SCENARIO_1.terms],
      hard: [],
      soft: [{ attribute: "countryOfOrigin", prefer: "fi" }],
      quantity: s1.quantity,
      deliverBy: date,
      paymentTerms: "invoice",
    },
    1,
  );
  return top?.productId ?? null;
}

const USAGE =
  "Usage: check-demo-data.ts --date YYYY-MM-DD [--ids id1,id2,...] [--database-env NAME]";

/** `--ids` replaces the shortlist for one exploratory run; without it the demo products are checked. */
export function parseArgs(args: readonly string[]): {
  date: string;
  ids?: readonly string[];
  databaseEnv?: string;
} {
  let date: string | undefined;
  let ids: readonly string[] | undefined;
  let databaseEnv: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) throw new Error(USAGE);
    if (args[index] === "--date") date = value;
    else if (args[index] === "--ids") ids = value.split(",").filter((id) => id !== "");
    else if (args[index] === "--database-env") databaseEnv = value;
    else throw new Error(USAGE);
  }
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(USAGE);
  return {
    date,
    ...(ids === undefined ? {} : { ids }),
    ...(databaseEnv === undefined ? {} : { databaseEnv }),
  };
}

export function validateCandidates(ids: readonly string[]) {
  if (ids.length === 0 || ids.length > 40) throw new Error("Expected 1 to 40 candidate ids");
}

export function mapRow(id: string, availability: Availability[], prices: Price[]) {
  const a = availability.find((item) => item.productId === id);
  const line = a?.salesBlock
    ? undefined
    : a?.scheduleLines.find((item) => item.availableAmount > 0 && !item.salesBlock);
  const price = prices.find((item) => item.productId === id && !item.error);
  return {
    productId: id,
    amount: line?.availableAmount ?? null,
    date: line?.availableDate ?? null,
    stock: line ? (line.availableAmount === 999999 ? "unconfirmed" : "confirmed") : "unavailable",
    net: price?.catalogPrice?.value ?? null,
    gross: price?.catalogPrice?.valueWithTax ?? null,
    comparison: price?.comparisonPrice?.value ?? null,
    comparisonUnit: price?.comparisonUnit ?? null,
  };
}

type Row = ReturnType<typeof mapRow> & { volume: number | null; substitutes: string[] };

/** The mock reports unlimited stock as 999999 (unconfirmed) or as a very large confirmed amount. */
const UNLIMITED = 999999;
/** A safe upper bound for scenario 3; the demo account itself has no credit check (SPEC-015). */
const CREDIT_LIMIT_GROSS = 5000;

/** A requested quantity in sales units, or litres through the sales-unit volume. */
export function salesUnits(
  quantity: { value: number; unit: string },
  row: Pick<Row, "volume">,
  salesUnit: string | undefined,
): number {
  if (quantity.unit === salesUnit) return quantity.value;
  if (quantity.unit === "LTR" && row.volume) return quantity.value / row.volume;
  return Number.POSITIVE_INFINITY;
}

/**
 * Scenario 3 (#83): confirmed stock below the request, a gross total under the credit limit,
 * and at least one listed substitute that is priced, deliverable by the date and not blocked.
 */
export function isShortWithSubstitute(input: {
  row: Row;
  units: number;
  substitutes: readonly Row[];
  date: string;
}): boolean {
  const { row, units, substitutes, date } = input;
  const finite = row.stock === "confirmed" && row.amount !== null && row.amount < UNLIMITED;
  const gross = row.gross === null ? null : units * row.gross;
  const orderable = substitutes.some(
    (s) =>
      s.stock !== "unavailable" &&
      s.gross !== null &&
      s.date !== null &&
      s.date.slice(0, 10) <= date,
  );
  return (
    finite &&
    row.amount !== null &&
    Number.isFinite(units) &&
    units > row.amount &&
    gross !== null &&
    gross < CREDIT_LIMIT_GROSS &&
    row.substitutes.length > 0 &&
    orderable
  );
}

/** The late clip (#83): the first open schedule line is after the requested date. */
export function isLate(row: Pick<Row, "date">, date: string): boolean {
  return row.date !== null && row.date.slice(0, 10) > date;
}

export function selectDatabaseUrl(
  baseUrl: string | undefined,
  local: { url: string; port: number } | undefined,
  explicit: string | undefined,
): string {
  if (explicit !== undefined) return explicit;
  if (local === undefined) throw new Error("Select the target with --database-env NAME.");
  if (baseUrl !== undefined) {
    const target = new URL(baseUrl);
    if (
      target.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      Number(target.port || 80) !== local.port ||
      target.pathname !== "/" ||
      target.search !== "" ||
      target.hash !== "" ||
      target.username !== "" ||
      target.password !== ""
    )
      throw new Error(
        "Application target is not this worktree. Select its database with --database-env NAME.",
      );
  }
  return local.url;
}

export async function demoDatabaseUrl(baseUrl?: string, databaseEnv?: string): Promise<string> {
  if (databaseEnv !== undefined) {
    const explicit = env(databaseEnv);
    if (explicit === undefined)
      throw new Error(`Missing database environment variable: ${databaseEnv}`);
    return selectDatabaseUrl(baseUrl, undefined, explicit);
  }
  return selectDatabaseUrl(baseUrl, await currentDatabase(), undefined);
}

async function main() {
  const key = Bun.env["VALIO_AIMO_API_KEY"];
  if (!key) {
    console.error("Missing VALIO_AIMO_API_KEY");
    process.exitCode = 2;
    return;
  }
  const apiKey: string = key;
  const { date, ids: explicitIds, databaseEnv } = parseArgs(process.argv.slice(2));
  const db = openDb(await demoDatabaseUrl(undefined, databaseEnv));
  const [products, demo] = await (async () => {
    try {
      return await Promise.all([loadCatalogProducts(db), readDemoProducts(db)]);
    } finally {
      await closeDb(db);
    }
  })();
  if (!demo) throw new Error("Demo products are not configured in the catalogue database.");
  const scenarios = [demo.s1, demo.s2, demo.s3, demo.late, ...demo.triedForS3];
  const scenarioIds = scenarios.flatMap((scenario) =>
    scenario === null ? [] : [scenario.productId],
  );
  const ids = explicitIds ?? [
    ...new Set([
      ...scenarioIds,
      ...products
        .filter((product) => scenarioIds.includes(product.productId))
        .flatMap((product) => product.substitutes),
    ]),
  ];
  validateCandidates(ids);
  let requests = 0;
  async function post(path: string) {
    if (++requests > 30) throw new Error("Request ceiling exceeded");
    const response = await fetch(
      `${(Bun.env["VALIO_AIMO_BASE_URL"] ?? BASE_URL).replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          customer: "cust_invoice_01",
          requestedDate: date,
          products: ids,
        }),
      },
    );
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }
  const availability: { products: Availability[] } = await post("/api/availability");
  const prices: { products: Price[] } = await post("/api/price");
  const rows = ids.map((id) => {
    const product = products.find((item) => item.productId === id);
    const row = Object.assign(mapRow(id, availability.products, prices.products), {
      reliability: product?.deliveryReliability ?? null,
      co2: product?.co2PerKg ?? null,
      lactose: product?.claims.has("FREE_FROM_LACTOSE") ?? false,
      volume: product?.perSalesUnit?.unit === "LTR" ? product.perSalesUnit.value : null,
      substitutes: product ? [...product.substitutes] : [],
    });
    console.log(JSON.stringify(row));
    return row;
  });
  if (demo) {
    const found = scenario1TopProduct(products, demo.s1, date);
    const sentenceOk = found === demo.s1.productId;
    console.log(`S1 sentence ${sentenceOk ? "ok" : `not ok (finds ${found ?? "nothing"} first)`}`);
    if (!sentenceOk) process.exitCode = 1;
    for (const [label, scenario, expected] of [
      ["S1", demo.s1, 20],
      ["S2", demo.s2, 1000],
    ] as const) {
      const row = rows.find((r) => r.productId === scenario.productId);
      const units = row?.volume ? scenario.quantity.value / row.volume : Infinity;
      const gross = row?.gross == null ? null : units * row.gross;
      const ok =
        scenario.quantity.unit === "LTR" &&
        scenario.quantity.value === expected &&
        row?.stock === "confirmed" &&
        row.amount !== null &&
        row.amount >= units &&
        row.date !== null &&
        row.date.slice(0, 10) <= date &&
        row.lactose &&
        (row.reliability === null || row.reliability >= 0.9) &&
        (row.co2 === null || row.co2 <= 3) &&
        gross !== null &&
        (label === "S1" ? gross < 1000 : gross > 1000);
      console.log(`${label} ${ok ? "ok" : "not ok"}`);
      if (!ok) process.exitCode = 1;
    }
    if (demo.s3) {
      const s3 = demo.s3;
      const product = products.find((item) => item.productId === s3.productId);
      const row = rows.find((r) => r.productId === s3.productId);
      const ok =
        row !== undefined &&
        isShortWithSubstitute({
          row,
          units: salesUnits(s3.quantity, row, product?.salesUnit),
          substitutes: rows.filter((r) => row.substitutes.includes(r.productId)),
          date,
        });
      console.log(`S3 ${ok ? "ok" : "not ok"}`);
      if (!ok) process.exitCode = 1;
    }
    if (demo.late) {
      const late = demo.late;
      const row = rows.find((r) => r.productId === late.productId);
      const ok = row !== undefined && isLate(row, date);
      console.log(`LATE ${ok ? "ok" : "not ok"}`);
      if (!ok) process.exitCode = 1;
    }
  }
  console.log(`Request count: ${requests}`);
}
if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
