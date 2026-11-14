import { z } from "zod";
import { PAYMENT_TERMS } from "./common.ts";
import { ConstraintsSchema } from "./search.ts";

export const PolicySchema = z.enum(["auto", "ask"]);
export type Policy = z.infer<typeof PolicySchema>;

const ThresholdSchema = z.strictObject({ value: z.number(), ifNoData: PolicySchema }).nullable();

/** A substitute product and the product it replaces. */
export const SubstitutePairSchema = z.strictObject({ replaces: z.string(), productId: z.string() });
export type SubstitutePair = z.infer<typeof SubstitutePairSchema>;

/** A human decision on one substitute pair: auto skips SUBSTITUTION, never stops the offer. */
export const SubstitutionRuleSchema = SubstitutePairSchema.extend({
  policy: z.enum(["auto", "never"]),
  /** Display only; the rule matches on ids. */
  productName: z.string().optional(),
  replacesName: z.string().optional(),
  decidedAt: z.iso.datetime({ offset: true }),
});
export type SubstitutionRule = z.infer<typeof SubstitutionRuleSchema>;

export const samePair = (a: SubstitutePair, b: SubstitutePair): boolean =>
  a.replaces === b.replaces && a.productId === b.productId;

export const MandateLimitsSchema = z.strictObject({
  maxOrderTotal: z.strictObject({
    value: z.number().nonnegative(),
    currency: z.literal("EUR"),
    basis: z.literal("gross"),
  }),
  /** null = all. */
  categories: z.array(z.string()).nullable(),
  substitutions: z.enum(["never", "ask", "auto"]),
  newProducts: PolicySchema,
  minDeliveryReliability: ThresholdSchema,
  maxCo2PerKg: ThresholdSchema,
  allergenData: z.strictObject({ ifNoData: PolicySchema }),
  paymentTerms: z.record(z.enum(PAYMENT_TERMS), PolicySchema),
  /** auto applies only while substitutions is ask; never always stops the offer. Absent = none. */
  substitutionRules: z.array(SubstitutionRuleSchema).optional(),
});
export type MandateLimits = z.infer<typeof MandateLimitsSchema>;

export const MandateSchema = z.strictObject({
  /** Customer. */
  iss: z.string(),
  mandateId: z.string(),
  version: z.number().int().positive(),
  /** agentId. */
  agent: z.string(),
  /** accountId. */
  signedBy: z.string(),
  limits: MandateLimitsSchema,
  standingConstraints: ConstraintsSchema,
  iat: z.number().int(),
  exp: z.number().int(),
});
export type Mandate = z.infer<typeof MandateSchema>;

export const StoredMandateSchema = z.strictObject({
  mandate: MandateSchema,
  jws: z.string().nullable(),
  status: z.enum(["active", "revoked"]),
  registeredAt: z.iso.datetime({ offset: true }),
});
export type StoredMandate = z.infer<typeof StoredMandateSchema>;

export const RegisterMandateRequestSchema = z.strictObject({
  operationId: z.string().optional(),
  limits: MandateLimitsSchema,
  standingConstraints: ConstraintsSchema,
  exp: z.number().int().optional(),
});
export type RegisterMandateRequest = z.infer<typeof RegisterMandateRequestSchema>;

export const MandateRefSchema = z.strictObject({ mandateId: z.string() });
export type MandateRef = z.infer<typeof MandateRefSchema>;
