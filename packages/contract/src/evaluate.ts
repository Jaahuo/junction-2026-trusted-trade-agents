import type { Quantity } from "./common.ts";
import type { Mandate } from "./mandate.ts";
import type { OfferClaims, ValidateResult } from "./offers.ts";
import type { Evaluation } from "./reasons.ts";

/** Steps 1-5 of SPEC-009. Pure: no I/O, no writes. */
export type Evaluate = (input: {
  claims: OfferClaims[];
  mandate: Mandate | null;
  history: { productId: string; quantity: Quantity }[];
  live: ValidateResult | null;
  now: Date;
}) => Evaluation;
