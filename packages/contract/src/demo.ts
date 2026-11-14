import { z } from "zod";
import type { Account } from "./account.ts";
import { QuantitySchema, TimeSchema, DateSchema } from "./common.ts";

export const DEMO_ACCOUNT: Account = {
  accountId: "acct_demo",
  label: "Demo kitchen (invoice)",
  customer: "cust_invoice_01",
  agentId: "agent_demo",
  paymentTerms: "invoice",
  creditLimit: 5000,
};

const ScenarioProductSchema = z.strictObject({ productId: z.string(), quantity: QuantitySchema });

export const DemoProductsSchema = z.strictObject({
  observedAt: TimeSchema,
  requestedDate: DateSchema,
  s1: ScenarioProductSchema,
  s2: ScenarioProductSchema,
  /** null = no product found. */
  s3: ScenarioProductSchema.nullable(),
  late: z.strictObject({ productId: z.string() }).nullable(),
  /** The wholesaler's substitute for s3; the seed gives it two earlier approvals. */
  s3Substitute: z.strictObject({ productId: z.string() }).optional(),
  triedForS3: z.array(ScenarioProductSchema),
});
export type DemoProducts = z.infer<typeof DemoProductsSchema>;
