import { DemoProductsSchema } from "../packages/contract/src/index.ts";

// Targeted shortlist only: two requests per run, each containing at most 40 IDs.
const CANDIDATES = [
  "464201",
  "464398",
  "464306",
  "463335",
  "464073",
  "464401",
  "464237",
  "463203",
  "477050",
  "462775",
  "464440",
  "465039",
  "469363",
  "473142",
  "466238",
  "462626",
  "464768",
  "465147",
  "471762",
];
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
type Product = {
  id: string;
  salesUnit?: string;
  substitutions?: { substituteProduct: string }[];
  synkkaData?: {
    classifications?: { name?: string; values?: { id?: string }[] }[];
    unitConversions?: { synkkaPackagingType?: string; volume?: { unit: string; value: number } }[];
  };
};

const USAGE = "Usage: check-demo-data.ts --date YYYY-MM-DD [--ids id1,id2,...]";

/** `--ids` replaces the shortlist for one exploratory run; without it the demo products are checked. */
export function parseArgs(args: readonly string[]): { date: string; ids: readonly string[] } {
  let date: string | undefined;
  let ids: readonly string[] = CANDIDATES;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) throw new Error(USAGE);
    if (args[index] === "--date") date = value;
    else if (args[index] === "--ids") ids = value.split(",").filter((id) => id !== "");
    else throw new Error(USAGE);
  }
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(USAGE);
  return { date, ids };
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
const CREDIT_LIMIT_GROSS = 5000;

/** A requested quantity in sales units: the sales unit itself, or litres through the consumer-unit volume. */
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

const csv = async (path: string) =>
  new Map(
    (await Bun.file(path).text())
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => {
        const [id, value] = line.split(",");
        return [id, Number(value)] as const;
      }),
  );

async function main() {
  const key = Bun.env["VALIO_AIMO_API_KEY"];
  if (!key) {
    console.error("Missing VALIO_AIMO_API_KEY");
    process.exitCode = 2;
    return;
  }
  const apiKey: string = key;
  const { date, ids } = parseArgs(process.argv.slice(2));
  validateCandidates(ids);
  const products: Product[] = await Bun.file("data/valio_aimo_junction26_product_data.json").json();
  const demoFile = Bun.file("data/demo-products.json");
  const demo = (await demoFile.exists()) ? DemoProductsSchema.parse(await demoFile.json()) : null;
  const reliability = await csv("data/valio_aimo_junction26_delivery_reliability.csv");
  const co2 = await csv("data/valio_aimo_junction26_carbon_footprint.csv");
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
    const product = products.find((item) => item.id === id);
    const lactose =
      product?.synkkaData?.classifications?.some(
        (c) => c.name === "nutritionalClaim" && c.values?.some((v) => v.id === "FREE_FROM_LACTOSE"),
      ) ?? false;
    const volume = product?.synkkaData?.unitConversions?.find(
      (u) => u.synkkaPackagingType === "BASE_UNIT_OR_EACH",
    )?.volume;
    const row = Object.assign(mapRow(id, availability.products, prices.products), {
      reliability: reliability.get(id) ?? null,
      co2: co2.get(id) ?? null,
      lactose,
      volume: volume?.unit === "LTR" ? volume.value : null,
      substitutes: product?.substitutions?.map((s) => s.substituteProduct) ?? [],
    });
    console.log(JSON.stringify(row));
    return row;
  });
  if (demo) {
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
      const product = products.find((item) => item.id === s3.productId);
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
