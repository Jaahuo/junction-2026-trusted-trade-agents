import { z } from "zod";
import {
  DateSchema,
  LineChangeSchema,
  MatchStateSchema,
  MoneyTotalSchema,
  PaymentTermsSchema,
  QuantitySchema,
  TimeSchema,
} from "./common.ts";
import { DecisionSchema, ReasonCodeSchema } from "./reasons.ts";
import { ConstraintsSchema, HardConstraintSchema, SoftConstraintSchema } from "./search.ts";
import { PriceQuoteSchema, StockSchema } from "./wholesaler.ts";

export const OffersRequestSchema = z.strictObject({
  lines: z.array(z.strictObject({ productId: z.string(), quantity: QuantitySchema })).min(1),
  deliverBy: DateSchema,
  paymentTerms: PaymentTermsSchema,
  hard: z.array(HardConstraintSchema),
  soft: z.array(SoftConstraintSchema),
});
export type OffersRequest = z.infer<typeof OffersRequestSchema>;

export const OfferClaimsSchema = z.strictObject({
  iss: z.string(),
  offerId: z.string(),
  customer: z.string(),
  agentId: z.string(),
  productId: z.string(),
  quantity: QuantitySchema,
  unitPrice: PriceQuoteSchema.shape.unitPrice,
  deposits: z.number(),
  total: MoneyTotalSchema,
  deliveryDate: DateSchema,
  requestedDate: DateSchema,
  nextDeliveryDate: DateSchema.nullable(),
  stock: StockSchema,
  paymentTerms: PaymentTermsSchema,
  cutoffAt: TimeSchema.nullable(),
  replaces: z.string().nullable(),
  /** Std units; sales units when perSalesUnit is null. */
  shortfall: QuantitySchema.nullable(),
  mandateId: z.string().nullable(),
  mandateVersion: z.number().int().nullable(),
  /** The merged set, SPEC-004. */
  constraints: ConstraintsSchema,
  product: z.strictObject({
    name: z.string(),
    category: z.string(),
    perSalesUnit: QuantitySchema.nullable(),
    countryOfOrigin: z.string().nullable(),
    deliveryReliability: z.number().min(0).max(1).nullable(),
    co2PerKg: z.number().nullable(),
    match: z.record(z.string(), MatchStateSchema),
  }),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type OfferClaims = z.infer<typeof OfferClaimsSchema>;

export const PrecheckSchema = z.strictObject({
  decision: DecisionSchema,
  reasons: z.array(ReasonCodeSchema),
});
export type Precheck = z.infer<typeof PrecheckSchema>;

export const OmitReasonSchema = z.enum([
  "NO_PRICE",
  "SALES_BLOCKED",
  "NO_DELIVERY_DATE",
  "UNKNOWN_PRODUCT",
  "INVALID_QUANTITY",
  "INSUFFICIENT_STOCK",
  "CONSTRAINT_CONTRADICTED",
]);
export type OmitReason = z.infer<typeof OmitReasonSchema>;

export const OfferLineSchema = z.strictObject({
  offerId: z.string(),
  token: z.string(),
  claims: OfferClaimsSchema,
  precheck: PrecheckSchema.nullable(),
  rank: z.enum(["good", "better", "best"]).nullable(),
  comparison: z
    .strictObject({
      replaces: z.string(),
      pricePerStdUnitDelta: z.number().nullable(),
      reliabilityDelta: z.number().nullable(),
      originDiffers: z.boolean().nullable(),
    })
    .nullable(),
});
export type OfferLine = z.infer<typeof OfferLineSchema>;

export const OffersResultSchema = z.strictObject({
  offers: z.array(OfferLineSchema),
  omitted: z.array(
    z.strictObject({ productId: z.string(), reason: OmitReasonSchema, detail: z.string() }),
  ),
});
export type OffersResult = z.infer<typeof OffersResultSchema>;

const TokensSchema = z.array(z.string()).min(1);

export const RequoteRequestSchema = z.strictObject({
  tokens: TokensSchema,
  changes: z.array(LineChangeSchema).optional(),
});
export type RequoteRequest = z.infer<typeof RequoteRequestSchema>;

export const ValidateRequestSchema = z.strictObject({ tokens: TokensSchema });
export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

export const ValidateResultSchema = z.strictObject({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.strictObject({ offerId: z.string(), ok: z.literal(true) }),
      z.strictObject({
        offerId: z.string(),
        ok: z.literal(false),
        reason: z.enum(["SALES_BLOCKED", "NO_DELIVERY_DATE", "CUTOFF_PASSED"]),
        nextDeliveryDate: DateSchema.nullable(),
      }),
    ]),
  ),
  products: z.array(
    z.strictObject({
      productId: z.string(),
      /** Sales units; null = stock unconfirmed. */
      liveAmount: QuantitySchema.nullable(),
    }),
  ),
});
export type ValidateResult = z.infer<typeof ValidateResultSchema>;
