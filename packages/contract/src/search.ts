import { z } from "zod";
import { DateSchema, MatchStateSchema, PaymentTermsSchema, QuantitySchema } from "./common.ts";

/** Attributes with a data mapping (SPEC-004). */
export const HARD_CONSTRAINT_ATTRIBUTES = ["lactose"] as const;
export type HardConstraintAttribute = (typeof HARD_CONSTRAINT_ATTRIBUTES)[number];
export const HARD_CONSTRAINT_VALUES = { lactose: ["free_from"] } as const satisfies Record<
  HardConstraintAttribute,
  readonly string[]
>;
/** Hard constraint attributes gated by `allergenData`. */
export const ALLERGEN_ATTRIBUTES = ["lactose"] as const;

export const HardConstraintSchema = z.discriminatedUnion("attribute", [
  z.strictObject({
    attribute: z.literal("lactose"),
    is: z.enum(HARD_CONSTRAINT_VALUES.lactose, {
      error: "lactose supports only the value free_from",
    }),
  }),
]);
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
