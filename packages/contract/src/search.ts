import { z } from "zod";
import { DateSchema, MatchStateSchema, PaymentTermsSchema, QuantitySchema } from "./common.ts";

/**
 * Data mapping of each `free_from` attribute (SPEC-004): its GS1 allergen type code, its
 * `nutritionalClaim` code, and a claim that contradicts it.
 */
export const FREE_FROM_DATA = {
  almond: { allergen: "SA" },
  barley: { allergen: "GB" },
  beef: { allergen: "BF" },
  brazilNut: { allergen: "SR" },
  carrot: { allergen: "NW" },
  cashew: { allergen: "SC" },
  celery: { allergen: "BC" },
  chicken: { allergen: "CM" },
  cocoa: { allergen: "NC" },
  coconut: { allergen: "SO" },
  coriander: { allergen: "NK" },
  corn: { allergen: "NM" },
  crustacean: { allergen: "AC" },
  egg: { allergen: "AE", claim: "FREE_FROM_EGGS" },
  fish: { allergen: "AF" },
  gluten: { allergen: "AW", claim: "FREE_FROM_GLUTEN" },
  hazelnut: { allergen: "SH" },
  khorasanWheat: { allergen: "GK" },
  lactose: { allergen: "ML", claim: "FREE_FROM_LACTOSE", low: "LOW_LACTOSE" },
  linalool: { allergen: "BP" },
  lupin: { allergen: "NL" },
  macadamia: { allergen: "SM" },
  milk: { allergen: "AM" },
  mollusc: { allergen: "UM" },
  mustard: { allergen: "BM" },
  oat: { allergen: "GO" },
  pea: { allergen: "NE" },
  peanut: { allergen: "AP" },
  pecan: { allergen: "SP" },
  pineNut: { allergen: "PN" },
  pistachio: { allergen: "ST" },
  podFruit: { allergen: "NP" },
  pollock: { allergen: "ADQ" },
  pork: { allergen: "PO" },
  rye: { allergen: "NR" },
  sesame: { allergen: "AS" },
  shellfish: { allergen: "UN" },
  soy: { allergen: "AY", claim: "FREE_FROM_SOY" },
  spelt: { allergen: "GS" },
  sulphite: { allergen: "AU" },
  treeNut: { allergen: "AN" },
  tuna: { allergen: "ABD" },
  walnut: { allergen: "SW" },
  wheat: { allergen: "UW", claim: "FREE_FROM_WHEAT" },
  additives: { claim: "FREE_FROM_ADDITIVES" },
  artificialSweeteners: { claim: "FREE_FROM_ARTIFICIAL_SWEETENERS" },
  colouringAgents: { claim: "FREE_FROM_COLOURING_AGENTS" },
  fat: { claim: "FREE_FROM_FAT", low: "LOW_FAT" },
  gmo: { claim: "FREE_FROM_GMO" },
  preservatives: { claim: "FREE_FROM_PRESERVATIVES" },
  sodiumSalt: { claim: "FREE_FROM_SODIUM_SALT", low: "LOW_SODIUM_SALT" },
  sweeteners: { claim: "FREE_FROM_SWEETENERS" },
} as const satisfies Record<string, { allergen?: string; claim?: string; low?: string }>;
type FreeFromAttribute = keyof typeof FREE_FROM_DATA;
const isFreeFrom = (key: string): key is FreeFromAttribute => key in FREE_FROM_DATA;
const FREE_FROM_ATTRIBUTES = Object.keys(FREE_FROM_DATA).filter(isFreeFrom);

/** Attributes with a data mapping (SPEC-004): `is` is `free_from`, or `yes` for vegan. */
export const HARD_CONSTRAINT_ATTRIBUTES = [...FREE_FROM_ATTRIBUTES, "vegan"] as const;
export type HardConstraintAttribute = (typeof HARD_CONSTRAINT_ATTRIBUTES)[number];
/** Hard constraint attributes gated by `allergenData`: those with a GS1 allergen code. */
export const ALLERGEN_ATTRIBUTES = FREE_FROM_ATTRIBUTES.filter(
  (attribute) => "allergen" in FREE_FROM_DATA[attribute],
);

const unsupported = (issue: { input?: unknown }) => {
  const attribute =
    typeof issue.input === "object" && issue.input !== null && "attribute" in issue.input
      ? String(issue.input.attribute)
      : String(issue.input);
  return `unsupported hard constraint attribute "${attribute}"; supported: ${HARD_CONSTRAINT_ATTRIBUTES.join(", ")}`;
};

export const HardConstraintSchema = z.discriminatedUnion(
  "attribute",
  [
    z.strictObject({
      attribute: z.enum(FREE_FROM_ATTRIBUTES),
      is: z.literal("free_from", {
        error: "allergens and free-from claims support only free_from",
      }),
    }),
    z.strictObject({
      attribute: z.literal("vegan"),
      is: z.literal("yes", { error: "vegan supports only the value yes" }),
    }),
  ],
  { error: unsupported },
);
export type HardConstraint = z.infer<typeof HardConstraintSchema>;

export const SoftConstraintSchema = z.strictObject({ attribute: z.string(), prefer: z.string() });
export type SoftConstraint = z.infer<typeof SoftConstraintSchema>;

export const ConstraintsSchema = z.strictObject({
  hard: z.array(HardConstraintSchema),
  soft: z.array(SoftConstraintSchema),
});

export const SearchRequestSchema = z.strictObject({
  terms: z.array(z.string().min(1)).min(1),
  hard: z.array(HardConstraintSchema),
  soft: z.array(SoftConstraintSchema),
  quantity: QuantitySchema,
  deliverBy: DateSchema,
  paymentTerms: PaymentTermsSchema,
  originalRequest: z.string().optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

const MatchSchema = z.record(z.string(), MatchStateSchema);

export const SearchCandidateSchema = z.strictObject({
  productId: z.string(),
  gtin: z.string().nullable(),
  name: z.string(),
  category: z.string(),
  match: MatchSchema,
  orderQuantity: QuantitySchema.nullable(),
  equals: QuantitySchema.nullable(),
  quantityReason: z.string().optional(),
  deliveryReliability: z.number().min(0).max(1).nullable(),
  co2PerKg: z.number().nullable(),
  substitutes: z.array(z.string()),
});
export type SearchCandidate = z.infer<typeof SearchCandidateSchema>;

export const SearchResultSchema = z.strictObject({
  candidates: z.array(SearchCandidateSchema).max(20),
  constraints: ConstraintsSchema,
  mandate: z.strictObject({ id: z.string(), version: z.number().int() }).nullable(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const FactsRequestSchema = z.strictObject({
  productIds: z.array(z.string()),
  hard: z.array(HardConstraintSchema),
});
export type FactsRequest = z.infer<typeof FactsRequestSchema>;

export const ProductFactsSchema = z.strictObject({
  productId: z.string(),
  gtin: z.string().nullable(),
  name: z.string(),
  category: z.string(),
  salesUnit: z.string(),
  allowedLotSize: z.number(),
  perSalesUnit: QuantitySchema.nullable(),
  countryOfOrigin: z.string().nullable(),
  deliveryReliability: z.number().min(0).max(1).nullable(),
  co2PerKg: z.number().nullable(),
  match: MatchSchema,
  substitutes: z.array(z.string()),
});
export type ProductFacts = z.infer<typeof ProductFactsSchema>;

export const FactsResultSchema = z.strictObject({
  products: z.array(ProductFactsSchema),
  unknown: z.array(z.string()),
});
export type FactsResult = z.infer<typeof FactsResultSchema>;
