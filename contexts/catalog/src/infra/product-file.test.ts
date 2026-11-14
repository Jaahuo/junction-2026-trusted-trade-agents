import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toOrderQuantity } from "../domain/quantity.ts";
import { DATA_FILES, loadProductFile, parseValueCsv } from "./product-file.ts";

// Invented products in the shape of the product file (team rules R-23).
const raw = (
  id: string,
  overrides: Record<string, unknown> = {},
  synkka: Record<string, unknown> = {},
) => ({
  id,
  salesUnitGtin: `000${id}`,
  salesUnit: "KI",
  baseUnit: "ST",
  category: "T-CAT",
  allowedLotSize: 1,
  countryOfOrigin: "fi",
  units: [
    { unitId: "KI", sizeInBaseUnits: 8 },
    { unitId: "ST", sizeInBaseUnits: 1 },
  ],
  synkkaData: {
    names: [
      { value: `Testijuoma ${id}`, language: "fi" },
      { value: `Test drink ${id}`, language: "en" },
    ],
    classifications: [],
    unitConversions: [],
    ...synkka,
  },
  ...overrides,
});

const conversion = (type: string, unit: string, value: number) => ({
  unitConversions: [{ synkkaPackagingType: type, volume: { unit, value } }],
});

const records = [
  raw(
    "T-1",
    { substitutions: [{ product: "T-1", substituteProduct: "T-2" }] },
    {
      ...conversion("BASE_UNIT_OR_EACH", "LTR", 1.5),
      classifications: [
        { name: "allergen", values: [{ id: "AM" }, { id: "AE", unit: "MAY_CONTAIN" }] },
        { name: "nonAllergen", values: [{ id: "AW", unit: "FREE_FROM" }] },
        { name: "nutritionalClaim", values: [{ id: "FREE_FROM_LACTOSE" }, { id: "LOW_FAT" }] },
      ],
    },
  ),
  raw("T-2", {}, conversion("BASE_UNIT_OR_EACH", "GRM", 250)),
  raw("T-3", { salesUnitGtin: undefined, countryOfOrigin: undefined }, { names: [] }),
  raw("T-KI-CASE", {}, conversion("CASE", "LTR", 7)),
  raw(
    "T-KG-1",
    {
      salesUnit: "KG",
      baseUnit: "KG",
      allowedLotSize: 3.5,
      units: [
        { unitId: "KG", sizeInBaseUnits: 1 },
        { unitId: "ST", sizeInBaseUnits: 3.5 },
      ],
    },
    conversion("BASE_UNIT_OR_EACH", "GRM", 3500),
  ),
  raw(
    "T-KG-2",
    {
      salesUnit: "KG",
      baseUnit: "KG",
      allowedLotSize: 0.01,
      units: [{ unitId: "KG", sizeInBaseUnits: 1 }],
    },
    conversion("BASE_UNIT_OR_EACH", "GRM", 1200),
  ),
  raw(
    "T-KI-OF-KG",
    {
      baseUnit: "KG",
      units: [
        { unitId: "KG", sizeInBaseUnits: 1 },
        { unitId: "KI", sizeInBaseUnits: 3 },
      ],
    },
    conversion("BASE_UNIT_OR_EACH", "GRM", 750),
  ),
  raw(
    "T-CS",
    { salesUnit: "CS", baseUnit: "CS", units: [{ unitId: "CS", sizeInBaseUnits: 1 }] },
    conversion("CASE", "GRM", 7500),
  ),
  raw(
    "T-ST-CASE",
    { salesUnit: "ST", units: [{ unitId: "ST", sizeInBaseUnits: 1 }] },
    conversion("CASE", "LTR", 7),
  ),
  raw(
    "T-EACH",
    { salesUnit: "ST", units: [{ unitId: "ST", sizeInBaseUnits: 1 }] },
    conversion("BASE_UNIT_OR_EACH", "MLT", 750),
  ),
  raw(
    "T-RATIO",
    {
      baseUnit: "PAK",
      units: [
        { unitId: "KI", sizeInBaseUnits: 6 },
        { unitId: "ST", sizeInBaseUnits: 2 },
      ],
    },
    conversion("BASE_UNIT_OR_EACH", "LTR", 2),
  ),
  raw(
    "T-UNKNOWN-BASE",
    {
      baseUnit: "PAK",
      units: [{ unitId: "KI", sizeInBaseUnits: 6 }],
    },
    conversion("BASE_UNIT_OR_EACH", "LTR", 2),
  ),
  raw(
    "T-CASE-AND-EACH",
    {},
    {
      unitConversions: [
        { synkkaPackagingType: "CASE", volume: { unit: "LTR", value: 9 } },
        { synkkaPackagingType: "BASE_UNIT_OR_EACH", volume: { unit: "LTR", value: 1 } },
      ],
    },
  ),
  { id: "T-BROKEN" },
];

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "catalog-index-"));
  await Bun.write(join(dir, DATA_FILES.products), JSON.stringify(records));
  await Bun.write(
    join(dir, DATA_FILES.reliability),
    "productId,deliveryReliability\r\nT-1,0.97\r\nT-2,1.5\r\n",
  );
  await Bun.write(join(dir, DATA_FILES.co2), "productId,AVG kg CO2-eq/kg\r\nT-1,2.34\r\nT-3,\r\n");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const byId = async () =>
  new Map((await loadProductFile(dir)).map((product) => [product.productId, product]));

test("the slim index maps names, claims, volume per sales unit, reliability, CO2 and substitutes", async () => {
  const products = await byId();
  expect([...products.keys()]).toEqual([
    "T-1",
    "T-2",
    "T-3",
    "T-KI-CASE",
    "T-KG-1",
    "T-KG-2",
    "T-KI-OF-KG",
    "T-CS",
    "T-ST-CASE",
    "T-EACH",
    "T-RATIO",
    "T-UNKNOWN-BASE",
    "T-CASE-AND-EACH",
  ]);
  expect(products.get("T-1")).toEqual({
    productId: "T-1",
    gtin: "000T-1",
    name: "Test drink T-1",
    searchText: "testijuoma t-1\ntest drink t-1",
    category: "T-CAT",
    salesUnit: "KI",
    allowedLotSize: 1,
    perSalesUnit: { value: 12, unit: "LTR" },
    countryOfOrigin: "fi",
    deliveryReliability: 0.97,
    co2PerKg: 2.34,
    claims: new Set(["MAY_CONTAIN:AE", "FREE_FROM:AW", "FREE_FROM_LACTOSE", "LOW_FAT"]),
    substitutes: ["T-2"],
  });
  expect(products.get("T-2")).toMatchObject({
    perSalesUnit: { value: 2, unit: "KGM" },
    deliveryReliability: null,
    co2PerKg: null,
  });
  expect(products.get("T-3")).toMatchObject({
    gtin: null,
    name: "T-3",
    perSalesUnit: null,
    countryOfOrigin: null,
    claims: new Set(),
  });
});

test("CSV values parse with CRLF line ends and skip blank or out-of-range values", () => {
  expect(parseValueCsv("id,v\r\na,0.5\r\nb,\r\nc,2\r\n", { min: 0, max: 1 })).toEqual(
    new Map([["a", 0.5]]),
  );
});

test("the volume per sales unit comes from weight, case, or identifiable consumer units", async () => {
  const products = await byId();
  expect(
    Object.fromEntries(
      [...products].map(([productId, product]) => [productId, product.perSalesUnit]),
    ),
  ).toMatchObject({
    "T-1": { value: 12, unit: "LTR" },
    "T-KG-1": { value: 1, unit: "KGM" },
    "T-KG-2": { value: 1, unit: "KGM" },
    "T-KI-OF-KG": { value: 3, unit: "KGM" },
    "T-KI-CASE": { value: 7, unit: "LTR" },
    "T-CS": { value: 7.5, unit: "KGM" },
    "T-ST-CASE": null,
    "T-EACH": { value: 0.75, unit: "LTR" },
    "T-RATIO": { value: 6, unit: "LTR" },
    "T-UNKNOWN-BASE": null,
    "T-CASE-AND-EACH": { value: 9, unit: "LTR" },
  });
});

test("a weight or case sales unit converts a std quantity to its own unit, rounded up to the lot", async () => {
  const products = await byId();
  const convert = (productId: string, value: number, unit: string) => {
    const product = products.get(productId);
    return product === undefined ? null : toOrderQuantity({ value, unit }, product);
  };
  expect({
    exact: convert("T-KG-1", 35, "KGM"),
    lot: convert("T-KG-1", 15, "KGM"),
    grams: convert("T-KG-2", 2500, "GRM"),
    kiOfKg: convert("T-KI-OF-KG", 10, "KGM"),
    case: convert("T-CS", 7.5, "KGM"),
    consumer: convert("T-1", 100, "LTR"),
  }).toEqual({
    exact: { orderQuantity: { value: 35, unit: "KG" }, equals: { value: 35, unit: "KGM" } },
    lot: { orderQuantity: { value: 17.5, unit: "KG" }, equals: { value: 17.5, unit: "KGM" } },
    grams: { orderQuantity: { value: 2.5, unit: "KG" }, equals: { value: 2.5, unit: "KGM" } },
    kiOfKg: { orderQuantity: { value: 4, unit: "KI" }, equals: { value: 12, unit: "KGM" } },
    case: { orderQuantity: { value: 1, unit: "CS" }, equals: { value: 7.5, unit: "KGM" } },
    consumer: { orderQuantity: { value: 9, unit: "KI" }, equals: { value: 108, unit: "LTR" } },
  });
  expect(convert("T-EACH", 2, "LTR")).toEqual({
    orderQuantity: { value: 3, unit: "ST" },
    equals: { value: 2.25, unit: "LTR" },
  });
  expect(convert("T-UNKNOWN-BASE", 2, "LTR")).toEqual({
    orderQuantity: null,
    equals: null,
    quantityReason: "Sales unit conversion is unavailable.",
  });
});

test("a product file that is empty or has no valid record fails the load", async () => {
  const empty = await mkdtemp(join(tmpdir(), "catalog-empty-"));
  try {
    await Bun.write(join(empty, DATA_FILES.reliability), "productId,deliveryReliability\r\n");
    await Bun.write(join(empty, DATA_FILES.co2), "productId,AVG kg CO2-eq/kg\r\n");
    const failures: unknown[] = [];
    for (const fileRecords of [[], [{ id: "T-BAD" }]]) {
      await Bun.write(join(empty, DATA_FILES.products), JSON.stringify(fileRecords));
      failures.push(
        await loadProductFile(empty).then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : error),
        ),
      );
    }
    expect(failures).toEqual([
      `${DATA_FILES.products} has no valid product records (0 rejected)`,
      `${DATA_FILES.products} has no valid product records (1 rejected)`,
    ]);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
