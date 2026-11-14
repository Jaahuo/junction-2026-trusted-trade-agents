import type { Result } from "@app/kernel";
import { z } from "zod";
import { DateSchema, TimeSchema } from "./common.ts";
import type { FactsRequest, FactsResult, SearchCandidate, SearchRequest } from "./search.ts";

export const PriceQuoteSchema = z.strictObject({
  productId: z.string(),
  unitPrice: z.strictObject({ net: z.number(), vatRate: z.number(), currency: z.literal("EUR") }),
  /** Per sales unit. */
  deposit: z.number(),
  /** false: the source gives no deposit amount, so `deposit` is 0 and leaves deposits out. Absent = true. */
  depositKnown: z.boolean().optional(),
  comparisonPrice: z.strictObject({ value: z.number(), unit: z.enum(["LTR", "KGM"]) }).nullable(),
  validTo: TimeSchema,
});
export type PriceQuote = z.infer<typeof PriceQuoteSchema>;

export const StockSchema = z.enum(["confirmed", "unconfirmed"]);

export const AvailabilityQuoteSchema = z.strictObject({
  productId: z.string(),
  /** Sales units. */
  amount: z.number(),
  availableDate: DateSchema.nullable(),
  nextDeliveryDate: DateSchema.nullable(),
  cutoffAt: TimeSchema.nullable(),
  salesBlocked: z.boolean(),
  stock: StockSchema,
});
export type AvailabilityQuote = z.infer<typeof AvailabilityQuoteSchema>;

export const LiveQuerySchema = z.strictObject({
  customer: z.string(),
  requestedDate: DateSchema,
  productIds: z.array(z.string()).min(1).max(1000).readonly(),
});
export type LiveQuery = z.infer<typeof LiveQuerySchema>;

export interface WholesalerLive {
  getAvailability(
    q: LiveQuery,
  ): Promise<Result<{ quotes: AvailabilityQuote[]; missing: string[] }, "UPSTREAM_FAILED">>;
  getPrices(
    q: LiveQuery,
  ): Promise<Result<{ quotes: PriceQuote[]; missing: string[] }, "UPSTREAM_FAILED">>;
}

export interface WholesalerCatalog {
  searchCatalog(req: SearchRequest): readonly SearchCandidate[];
  facts(req: FactsRequest): FactsResult;
  getSubstitutes(productId: string): readonly string[];
}
