import { z } from "zod";

export const PAYMENT_TERMS = ["invoice", "pay_on_order"] as const;
export const PaymentTermsSchema = z.enum(PAYMENT_TERMS);
export type PaymentTerms = z.infer<typeof PaymentTermsSchema>;

/** A calendar date, `YYYY-MM-DD`. */
export const DateSchema = z.iso.date();
/** A time, ISO 8601 with offset. */
export const TimeSchema = z.iso.datetime({ offset: true });

export const QuantitySchema = z.strictObject({ value: z.number(), unit: z.string().min(1) });
export type Quantity = z.infer<typeof QuantitySchema>;

export const MatchStateSchema = z.enum(["confirmed", "contradicted", "unknown"]);
export type MatchState = z.infer<typeof MatchStateSchema>;

export const MoneyTotalSchema = z.strictObject({ net: z.number(), gross: z.number() });

export const EmptySchema = z.strictObject({});
export type Empty = z.infer<typeof EmptySchema>;

export const LineChangeSchema = z.strictObject({
  productId: z.string(),
  quantity: QuantitySchema.optional(),
  deliverBy: DateSchema.optional(),
});
