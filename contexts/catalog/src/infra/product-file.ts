import { resolve } from "node:path";
import type { Quantity } from "@app/contract";
import { contextsDir } from "@app/server-kit";
import { z } from "zod";
import type { CatalogProduct } from "../domain/catalog.ts";
import { perSalesUnit } from "../domain/quantity.ts";

export const DATA_FILES = {
  products: "valio_aimo_junction26_product_data.json",
  reliability: "valio_aimo_junction26_delivery_reliability.csv",
  co2: "valio_aimo_junction26_carbon_footprint.csv",
} as const;

export const defaultDataDir = (): string => resolve(contextsDir, "..", "data");

const LocalizedSchema = z.object({ value: z.string(), language: z.string() });

// Only the fields the slim index needs; zod drops the rest of each record.
const RawProductSchema = z.object({
  id: z.string(),
  salesUnitGtin: z.string().nullish(),
  salesUnit: z.string(),
  baseUnit: z.string(),
  category: z.string(),
  allowedLotSize: z.number(),
  countryOfOrigin: z.string().nullish(),
  units: z.array(z.object({ unitId: z.string(), sizeInBaseUnits: z.number() })),
  substitutions: z.array(z.object({ substituteProduct: z.string() })).nullish(),
  synkkaData: z.object({
    gtin: z.string().nullish(),
    names: z.array(LocalizedSchema),
    classifications: z
      .array(
        z.object({
          name: z.string().nullish(),
          values: z.array(z.object({ id: z.string().nullish() })).nullish(),
        }),
      )
      .nullish(),
    unitConversions: z
      .array(
        z.object({
          synkkaPackagingType: z.string().nullish(),
          volume: z.object({ unit: z.string(), value: z.number() }).nullish(),
        }),
      )
      .nullish(),
  }),
});
type RawProduct = z.infer<typeof RawProductSchema>;

const NAME_LANGUAGES = ["en", "fi", "sv"];

const displayName = (names: RawProduct["synkkaData"]["names"], fallback: string): string => {
  for (const language of NAME_LANGUAGES) {
    const name = names.find((entry) => entry.language === language)?.value;
    if (name !== undefined && name !== "") return name;
  }
  return names[0]?.value ?? fallback;
};

const nutritionalClaims = (raw: RawProduct): Set<string> =>
  new Set(
    (raw.synkkaData.classifications ?? [])
      .filter((classification) => classification.name === "nutritionalClaim")
      .flatMap((classification) => classification.values ?? [])
      .flatMap((value) => (typeof value.id === "string" ? [value.id] : [])),
  );

const WEIGHT_UNITS = new Map([["KG", { value: 1, unit: "KGM" }]]);
const CASE_UNITS = new Set(["KI", "CS", "KRT", "SK", "KLE"]);

/**
 * Volume of one sales unit, from the first source that applies:
 * 1. a weight base unit: the sales unit's own weight;
 * 2. the consumer-unit volume times consumer units per sales unit;
 * 3. the CASE volume when the sales unit is a case unit.
 */
const salesUnitVolume = (raw: RawProduct): Quantity | null => {
  const unitsPerSalesUnit =
    raw.units.find((unit) => unit.unitId === raw.salesUnit)?.sizeInBaseUnits ?? 0;
  const baseWeight = WEIGHT_UNITS.get(raw.baseUnit);
  if (baseWeight !== undefined) return perSalesUnit(baseWeight, unitsPerSalesUnit);
  const volumeOf = (type: string) =>
    raw.synkkaData.unitConversions?.find((conversion) => conversion.synkkaPackagingType === type)
      ?.volume ?? null;
  return (
    perSalesUnit(volumeOf("BASE_UNIT_OR_EACH"), unitsPerSalesUnit) ??
    (CASE_UNITS.has(raw.salesUnit) ? perSalesUnit(volumeOf("CASE"), 1) : null)
  );
};

const toProduct = (
  raw: RawProduct,
  reliability: ReadonlyMap<string, number>,
  co2: ReadonlyMap<string, number>,
): CatalogProduct => {
  return {
    productId: raw.id,
    gtin: raw.salesUnitGtin ?? raw.synkkaData.gtin ?? null,
    name: displayName(raw.synkkaData.names, raw.id),
    searchText: raw.synkkaData.names.map((entry) => entry.value.toLowerCase()).join("\n"),
    category: raw.category,
    salesUnit: raw.salesUnit,
    allowedLotSize: raw.allowedLotSize,
    perSalesUnit: salesUnitVolume(raw),
    countryOfOrigin: raw.countryOfOrigin ?? null,
    deliveryReliability: reliability.get(raw.id) ?? null,
    co2PerKg: co2.get(raw.id) ?? null,
    claims: nutritionalClaims(raw),
    substitutes: (raw.substitutions ?? []).map((substitution) => substitution.substituteProduct),
  };
};

/** `productId,value` rows; CRLF or LF line ends. Rows without a finite value are skipped. */
export const parseValueCsv = (text: string, range?: { min: number; max: number }) => {
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [id, raw] = line.split(",");
    if (id === undefined || id === "" || raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (range !== undefined && (value < range.min || value > range.max)) continue;
    values.set(id, value);
  }
  return values;
};

/** Reads the product file and the two CSV files into the slim index. */
export const loadProductFile = async (dataDir: string): Promise<CatalogProduct[]> => {
  const [reliabilityText, co2Text] = await Promise.all([
    Bun.file(resolve(dataDir, DATA_FILES.reliability)).text(),
    Bun.file(resolve(dataDir, DATA_FILES.co2)).text(),
  ]);
  const records: unknown = await Bun.file(resolve(dataDir, DATA_FILES.products)).json();
  if (!Array.isArray(records)) throw new Error(`${DATA_FILES.products} is not a JSON array`);
  const reliability = parseValueCsv(reliabilityText, { min: 0, max: 1 });
  const co2 = parseValueCsv(co2Text);
  const products: CatalogProduct[] = [];
  let skipped = 0;
  for (const record of records) {
    const parsed = RawProductSchema.safeParse(record);
    if (parsed.success) products.push(toProduct(parsed.data, reliability, co2));
    else skipped += 1;
  }
  if (skipped > 0)
    console.error(`catalog: skipped ${skipped} product records that fail the schema`);
  return products;
};
