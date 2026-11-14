import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_FILES, loadProductFile, parseValueCsv } from "./product-file.ts";

const raw = (
  id: string,
  overrides: Record<string, unknown> = {},
  synkka: Record<string, unknown> = {},
) => ({
  id,
  salesUnitGtin: `640${id}`,
  salesUnit: "KI",
  baseUnit: "ST",
  category: "10400",
  allowedLotSize: 1,
  countryOfOrigin: "fi",
  units: [
    { unitId: "KI", sizeInBaseUnits: 10 },
    { unitId: "ST", sizeInBaseUnits: 1 },
  ],
  synkkaData: {
    names: [
      { value: `Maito ${id}`, language: "fi" },
      { value: `Milk ${id}`, language: "en" },
    ],
    classifications: [],
    unitConversions: [],
    ...synkka,
  },
  ...overrides,
});

const baseVolume = (unit: string, value: number) => ({
  unitConversions: [{ synkkaPackagingType: "BASE_UNIT_OR_EACH", volume: { unit, value } }],
});

const records = [
  raw(
    "1",
    { substitutions: [{ product: "1", substituteProduct: "2" }] },
    {
      ...baseVolume("LTR", 1),
      classifications: [
        { name: "allergen", values: [{ id: "AM" }] },
        { name: "nutritionalClaim", values: [{ id: "FREE_FROM_LACTOSE" }, { id: "LOW_FAT" }] },
      ],
    },
  ),
  raw("2", {}, baseVolume("GRM", 500)),
  raw("3", { salesUnitGtin: undefined, countryOfOrigin: undefined }, { names: [] }),
  raw(
    "4",
    {},
    {
      unitConversions: [{ synkkaPackagingType: "CASE", volume: { unit: "LTR", value: 6 } }],
    },
  ),
  raw(
    "kg",
    {
      salesUnit: "KG",
      baseUnit: "KG",
      allowedLotSize: 4.4,
      units: [
        { unitId: "KG", sizeInBaseUnits: 1 },
        { unitId: "ST", sizeInBaseUnits: 4.4 },
      ],
    },
    baseVolume("GRM", 4400),
  ),
  raw(
    "ki-of-kg",
    {
      baseUnit: "KG",
      units: [
        { unitId: "KG", sizeInBaseUnits: 1 },
        { unitId: "KI", sizeInBaseUnits: 2 },
      ],
    },
    baseVolume("GRM", 500),
  ),
  raw(
    "cs",
    { salesUnit: "CS", baseUnit: "CS", units: [{ unitId: "CS", sizeInBaseUnits: 1 }] },
    { unitConversions: [{ synkkaPackagingType: "CASE", volume: { unit: "GRM", value: 6000 } }] },
  ),
  raw(
    "st",
    { salesUnit: "ST", units: [{ unitId: "ST", sizeInBaseUnits: 1 }] },
    { unitConversions: [{ synkkaPackagingType: "CASE", volume: { unit: "LTR", value: 6 } }] },
  ),
  { id: "broken" },
];

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "catalog-index-"));
  await Bun.write(join(dir, DATA_FILES.products), JSON.stringify(records));
  await Bun.write(
    join(dir, DATA_FILES.reliability),
    "productId,deliveryReliability\r\n1,0.98\r\n2,1.5\r\n",
  );
  await Bun.write(join(dir, DATA_FILES.co2), "productId,AVG kg CO2-eq/kg\r\n1,1.44\r\n3,\r\n");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the slim index maps names, claims, volume per sales unit, reliability, CO2 and substitutes", async () => {
  const products = await loadProductFile(dir);
  expect(products.map((product) => product.productId)).toEqual([
    "1",
    "2",
    "3",
    "4",
    "kg",
    "ki-of-kg",
    "cs",
    "st",
  ]);
  const [first, second, third, fourth] = products;
  expect(first).toEqual({
    productId: "1",
    gtin: "6401",
    name: "Milk 1",
    searchText: "maito 1\nmilk 1",
    category: "10400",
    salesUnit: "KI",
    allowedLotSize: 1,
    perSalesUnit: { value: 10, unit: "LTR" },
    countryOfOrigin: "fi",
    deliveryReliability: 0.98,
    co2PerKg: 1.44,
    claims: new Set(["FREE_FROM_LACTOSE", "LOW_FAT"]),
    substitutes: ["2"],
  });
  expect(second).toMatchObject({
    perSalesUnit: { value: 5, unit: "KGM" },
    deliveryReliability: null,
    co2PerKg: null,
  });
  expect(third).toMatchObject({
    gtin: null,
    name: "3",
    perSalesUnit: null,
    countryOfOrigin: null,
    claims: new Set(),
  });
  expect(fourth).toMatchObject({ perSalesUnit: { value: 6, unit: "LTR" } });
});

test("CSV values parse with CRLF line ends and skip blank or out-of-range values", () => {
  expect(parseValueCsv("id,v\r\na,0.5\r\nb,\r\nc,2\r\n", { min: 0, max: 1 })).toEqual(
    new Map([["a", 0.5]]),
  );
});

test("the volume per sales unit comes from the unit's own weight, then the consumer unit, then the case", async () => {
  const volumes = Object.fromEntries(
    (await loadProductFile(dir)).map((product) => [product.productId, product.perSalesUnit]),
  );
  expect(volumes).toMatchObject({
    kg: { value: 1, unit: "KGM" },
    "ki-of-kg": { value: 2, unit: "KGM" },
    cs: { value: 6, unit: "KGM" },
    st: null,
  });
});
