import { z } from "zod";
import { DateSchema, MoneyTotalSchema, PaymentTermsSchema, TimeSchema } from "./common.ts";
import { SubstitutePairSchema } from "./mandate.ts";
import { OfferClaimsSchema } from "./offers.ts";
import { ReasonCodeSchema } from "./reasons.ts";

export const ORDER_STATUSES = [
  "pending_approval",
  "awaiting_payment",
  "placed",
  "rejected",
  "declined",
] as const;
export const AUDIT_EVENTS = [
  "order_requested",
  "order_refused",
  "offer_verified",
  "check_passed",
  "check_failed",
  "sent_to_approval",
  "approved",
  "declined",
  "requoted",
  "edited",
  "payment_authorized",
  "payment_failed",
  "placed",
  "rejected",
] as const;

export const AuditEventSchema = z.strictObject({
  at: TimeSchema,
  actor: z.enum(["agent", "server", "approver"]),
  event: z.enum(AUDIT_EVENTS),
  rule: z.string().optional(),
  reason: ReasonCodeSchema.optional(),
  detail: z.string().optional(),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  previousHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
  /** The product a check applies to, for a reason about one product (a new product, CO₂ …). */
  productId: z.string().optional(),
  /** False when the entry no longer matches its signature (SPEC-010 audit integrity). */
  integrityOk: z.boolean().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

const ALLERGEN_RELATIONS = ["free_from", "contains", "may_contain"] as const;

/** An allergen fact of a line; `status` is its relation to the buyer's hard rules. */
const LineAllergenSchema = z.strictObject({
  allergen: z.string(),
  type: z.enum(ALLERGEN_RELATIONS),
  status: z.enum(["default", "warning", "error"]),
  /** The buyer's rule it meets or breaks, such as "no egg". */
  rule: z.string().optional(),
});

export const OrderLineSchema = z.strictObject({
  offerId: z.string(),
  token: z.string(),
  claims: OfferClaimsSchema,
  /** One sentence from the agent on why it picked this product. */
  rationale: z.string().optional(),
  allergens: z.array(LineAllergenSchema).optional(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const RequoteSchema = z.strictObject({
  at: TimeSchema,
  previous: OfferClaimsSchema,
  current: OfferClaimsSchema,
  reasons: z.array(ReasonCodeSchema),
});
export type Requote = z.infer<typeof RequoteSchema>;

export const DECISIONS = [
  "approve",
  "reject",
  "edit",
  "pick_alternative",
  "approve_and_remember",
] as const;

export const OrderSchema = z.strictObject({
  orderId: z.string(),
  customer: z.string(),
  agentId: z.string(),
  accountId: z.string(),
  offerIds: z.array(z.string()),
  lines: z.array(OrderLineSchema),
  alternatives: z.array(OrderLineSchema),
  mandateId: z.string().nullable(),
  mandateVersion: z.number().int().nullable(),
  status: z.enum(ORDER_STATUSES),
  reasons: z.array(ReasonCodeSchema),
  proposalVersion: z.number().int(),
  approvalUrl: z.string().nullable(),
  paymentTerms: PaymentTermsSchema,
  total: MoneyTotalSchema,
  originalRequest: z.string().nullable(),
  decision: z
    .strictObject({
      action: z.enum(DECISIONS),
      next: z.enum(["stop", "alternatives"]).nullable(),
      note: z.string().nullable(),
      by: z.string(),
      at: TimeSchema,
    })
    .nullable(),
  requotes: z.array(RequoteSchema),
  nextDeliveryDate: DateSchema.nullable(),
  audit: z.array(AuditEventSchema),
  createdAt: TimeSchema,
  receipt: z.string().optional(),
  auditAnchor: z
    .strictObject({ hash: z.string().regex(/^[0-9a-f]{64}$/), count: z.number().int().positive() })
    .optional(),
  /** What the order is for, written by the agent from the buyer's request. */
  purpose: z.string().optional(),
  offerSignature: z
    .strictObject({ state: z.enum(["verified", "expired", "invalid"]), validUntil: TimeSchema })
    .optional(),
  receiptSignature: z
    .strictObject({
      state: z.enum(["verified", "pending", "invalid"]),
      signedAt: TimeSchema.nullable(),
    })
    .optional(),
  auditIntegrity: z.enum(["intact", "unverified", "broken"]).optional(),
  /** Set only on the approve response, when the human may make this substitute automatic. */
  standingOffer: SubstitutePairSchema.extend({
    timesApproved: z.number().int(),
    /** The replaced product's name, from an order that had it as a line. */
    replacesName: z.string().optional(),
  }).optional(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderReceiptClaimsSchema = z.strictObject({
  iss: z.string(),
  orderId: OrderSchema.shape.orderId,
  customer: OrderSchema.shape.customer,
  agentId: OrderSchema.shape.agentId,
  accountId: OrderSchema.shape.accountId,
  offerIds: OrderSchema.shape.offerIds,
  lines: OrderSchema.shape.lines,
  mandateId: OrderSchema.shape.mandateId,
  mandateVersion: OrderSchema.shape.mandateVersion,
  paymentTerms: OrderSchema.shape.paymentTerms,
  total: OrderSchema.shape.total,
  decision: OrderSchema.shape.decision,
  createdAt: OrderSchema.shape.createdAt,
  placedAt: TimeSchema,
  auditAnchor: OrderSchema.shape.auditAnchor.unwrap(),
  status: z.literal("placed"),
});
export type OrderReceiptClaims = z.infer<typeof OrderReceiptClaimsSchema>;

export const PendingListSchema = z.strictObject({ orders: z.array(OrderSchema) });
export type PendingList = z.infer<typeof PendingListSchema>;

const OfferTokensSchema = z.array(z.string()).min(1).max(20);

export const PlaceOrderRequestSchema = z.strictObject({
  offers: OfferTokensSchema,
  alternatives: z.array(z.string()).optional(),
  originalRequest: z.string().optional(),
  idempotencyKey: z.string().min(1),
});
export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequestSchema>;

export const PrecheckRequestSchema = z.strictObject({ offers: OfferTokensSchema });
export type PrecheckRequest = z.infer<typeof PrecheckRequestSchema>;

export const OrderRefSchema = z.strictObject({ orderId: z.string() });
export type OrderRef = z.infer<typeof OrderRefSchema>;
