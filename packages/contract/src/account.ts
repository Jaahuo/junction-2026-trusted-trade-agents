import { z } from "zod";
import { PaymentTermsSchema } from "./common.ts";

export const AccountSchema = z.strictObject({
  accountId: z.string(),
  label: z.string(),
  customer: z.string(),
  agentId: z.string(),
  paymentTerms: PaymentTermsSchema,
  /** EUR gross; null = no credit check. */
  creditLimit: z.number().nullable(),
});
export type Account = z.infer<typeof AccountSchema>;
export type Principal = Account;
