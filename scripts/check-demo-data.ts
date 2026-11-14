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
  substitutions?: { substituteProduct: string }[];
  synkkaData?: {
    classifications?: { name?: string; values?: { id?: string }[] }[];
    unitConversions?: { synkkaPackagingType?: string; volume?: { unit: string; value: number } }[];
  };
};

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
  const args = process.argv.slice(2);
  const date = args[1];
  if (
    args.length !== 2 ||
    args[0] !== "--date" ||
    date === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  )
    throw new Error("Usage: check-demo-data.ts --date YYYY-MM-DD");
  validateCandidates(CANDIDATES);
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
          products: CANDIDATES,
        }),
      },
    );
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }
  const availability: { products: Availability[] } = await post("/api/availability");
  const prices: { products: Price[] } = await post("/api/price");
  const rows = CANDIDATES.map((id) => {
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
  }
  console.log(`Request count: ${requests}`);
}
if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
