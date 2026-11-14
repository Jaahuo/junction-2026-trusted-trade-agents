import { z } from "zod";

export const APPROVAL_REASONS = [
  "SPEND_OVER_LIMIT",
  "CATEGORY_NOT_ALLOWED",
  "SUBSTITUTION",
  "NEW_PRODUCT",
  "RELIABILITY_BELOW_MIN",
  "CO2_ABOVE_MAX",
  "UNCONFIRMED_DATA",
  "UNCONFIRMED_ALLERGEN",
  "UNCONFIRMED_STOCK",
  "QUANTITY_UNUSUAL",
  "PAYMENT_TERMS",
  "PRICE_CHANGED",
  "AVAILABILITY_DIFFERS",
] as const;
export const REJECT_REASONS = [
  "NOT_AUTHENTICATED",
  "MANDATE_INVALID",
  "OFFER_INVALID",
  "OFFER_EXPIRED",
  "CREDIT_LIMIT",
  "PAYMENT_FAILED",
  "CUTOFF_PASSED",
  "SALES_BLOCKED",
] as const;
export const ReasonCodeSchema = z.enum([...APPROVAL_REASONS, ...REJECT_REASONS]);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

/** One plain sentence per reason code. */
export const REASON_TEXT: Record<ReasonCode, string> = {
  SPEND_OVER_LIMIT: "The order total is above the mandate's spending limit.",
  CATEGORY_NOT_ALLOWED: "The product category is not allowed by the mandate.",
  SUBSTITUTION: "The order includes a substitute product.",
  NEW_PRODUCT: "The product has not been ordered before.",
  RELIABILITY_BELOW_MIN: "The product's delivery reliability is below the mandate's minimum.",
  CO2_ABOVE_MAX: "The product's estimated CO2 per kg is above the mandate's maximum.",
  UNCONFIRMED_DATA: "Reliability or CO2 data is missing for the product.",
  UNCONFIRMED_ALLERGEN: "A required allergen property of the product is not confirmed.",
  UNCONFIRMED_STOCK: "The supplier does not confirm stock for this large a quantity.",
  QUANTITY_UNUSUAL: "The quantity is far above this product's usual orders.",
  PAYMENT_TERMS: "The mandate asks for approval of these payment terms.",
  PRICE_CHANGED: "The price changed since the offer was made.",
  AVAILABILITY_DIFFERS: "The delivery date or amount changed since the offer was made.",
  NOT_AUTHENTICATED: "The request was not authenticated.",
  MANDATE_INVALID: "There is no valid mandate for the agent.",
  OFFER_INVALID: "An offer token failed verification.",
  OFFER_EXPIRED: "An offer expired before the order was placed.",
  CREDIT_LIMIT: "The order total is above the remaining credit.",
  PAYMENT_FAILED: "The payment was not authorized.",
  CUTOFF_PASSED: "The order cut-off for the delivery date has passed.",
  SALES_BLOCKED: "The product is blocked from sale.",
};

/** No mandate setting turns these into auto. */
export const FORCED_APPROVAL = ["QUANTITY_UNUSUAL", "UNCONFIRMED_STOCK"] as const;

export const GUARDRAILS = {
  quantityCapFactor: 10,
  /** Std units. */
  quantityCapNoHistory: 2000,
  /** Std units per product. */
  unconfirmedStockMax: 500,
  /** EUR gross. */
  paymentFailAbove: 5000,
  maxLinesPerOrder: 20,
} as const;

export const DecisionSchema = z.enum(["auto", "needs_approval", "rejected"]);
/** The result of SPEC-009 steps 1-5 and of the offers pre-check: `auto` carries no reason. */
export const EvaluationSchema = z
  .strictObject({
    decision: DecisionSchema,
    reasons: z.array(ReasonCodeSchema),
  })
  .refine((evaluation) => evaluation.decision !== "auto" || evaluation.reasons.length === 0, {
    message: "An auto decision carries no reasons.",
    path: ["reasons"],
  });
export type Evaluation = z.infer<typeof EvaluationSchema>;
