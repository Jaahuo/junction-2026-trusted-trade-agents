import type { Quantity } from "@app/contract";
import { z } from "zod";
import type { CatalogProduct } from "../domain/catalog.ts";
import { perSalesUnit } from "../domain/quantity.ts";

const LocalizedSchema = z.object({ value: z.string(), language: z.string() });

// Only the fields the slim index needs; zod drops the rest of each record.
export const RawProductSchema = z.object({
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
          values: z
            .array(z.object({ id: z.string().nullish(), unit: z.string().nullish() }))
            .nullish(),
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

const ALLERGEN_GROUPS = new Set(["allergen", "nonAllergen"]);

/** Nutritional claim codes, and allergen facts as `<unit>:<GS1 code>`; an allergen without a unit is skipped. */
const claims = (raw: RawProduct): Set<string> =>
  new Set(
    (raw.synkkaData.classifications ?? []).flatMap((classification) =>
      (classification.values ?? []).flatMap(({ id, unit }) => {
        if (typeof id !== "string") return [];
        if (classification.name === "nutritionalClaim") return [id];
        if (ALLERGEN_GROUPS.has(classification.name ?? "") && typeof unit === "string")
          return [`${unit}:${id}`];
        return [];
      }),
    ),
  );

const WEIGHT_UNITS = new Map([
  ["KG", { value: 1, unit: "KGM" }],
  ["KGM", { value: 1, unit: "KGM" }],
]);
const CASE_UNITS = new Set(["KI", "CS", "KRT", "SK", "KLE"]);

/**
 * Volume of one sales unit, from the first source that applies:
 * 1. a weight base unit: the sales unit's own weight;
 * 2. the CASE volume when the sales unit is a case unit;
 * 3. the consumer-unit volume times consumer units per sales unit.
 */
const salesUnitVolume = (raw: RawProduct): Quantity | null => {
  const salesSize = raw.units.find((unit) => unit.unitId === raw.salesUnit)?.sizeInBaseUnits;
  const baseWeight = WEIGHT_UNITS.get(raw.baseUnit);
  if (baseWeight !== undefined) return perSalesUnit(baseWeight, salesSize ?? 0);
  const volumeOf = (type: string) =>
    raw.synkkaData.unitConversions?.find((conversion) => conversion.synkkaPackagingType === type)
      ?.volume ?? null;
  const consumerSize =
    raw.baseUnit === "ST" ? 1 : raw.units.find((unit) => unit.unitId === "ST")?.sizeInBaseUnits;
  const unitsPerSalesUnit =
    salesSize !== undefined &&
    consumerSize !== undefined &&
    Number.isFinite(consumerSize) &&
    consumerSize > 0
      ? salesSize / consumerSize
      : 0;
  return (
    (CASE_UNITS.has(raw.salesUnit) ? perSalesUnit(volumeOf("CASE"), 1) : null) ??
    perSalesUnit(volumeOf("BASE_UNIT_OR_EACH"), unitsPerSalesUnit)
  );
};

export const toProduct = (
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
    claims: claims(raw),
    substitutes: (raw.substitutions ?? []).map((substitution) => substitution.substituteProduct),
  };
};
