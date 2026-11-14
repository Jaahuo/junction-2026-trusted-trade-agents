import { z } from "zod";
import { LineChangeSchema } from "./common.ts";
import { DECISIONS } from "./orders.ts";

const NextSchema = z.enum(["stop", "alternatives"]);
const proposalVersion = z.number().int();

const decisionVariants = {
  approve: { decision: z.literal("approve") },
  reject: { decision: z.literal("reject"), next: NextSchema, note: z.string().optional() },
  edit: { decision: z.literal("edit"), changes: z.array(LineChangeSchema).min(1) },
  pickAlternative: { decision: z.literal("pick_alternative"), offerId: z.string() },
  approveAndRemember: {
    decision: z.literal("approve_and_remember"),
    maxOrderTotal: z.number().nonnegative(),
  },
} as const;

const decisionUnion = <S extends z.ZodRawShape>(extra: S) =>
  z.discriminatedUnion("decision", [
    z.strictObject({ ...extra, proposalVersion, ...decisionVariants.approve }),
    z.strictObject({ ...extra, proposalVersion, ...decisionVariants.reject }),
    z.strictObject({ ...extra, proposalVersion, ...decisionVariants.edit }),
    z.strictObject({ ...extra, proposalVersion, ...decisionVariants.pickAlternative }),
    z.strictObject({ ...extra, proposalVersion, ...decisionVariants.approveAndRemember }),
  ]);

/** The body of the decision route (SPEC-011). */
export const DecideApprovalRequestSchema = decisionUnion({});
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequestSchema>;

/** The decide route input: the `orderId` path parameter and the body. */
export const DecideApprovalRouteInputSchema = decisionUnion({ orderId: z.string() });

/** The flat tool input of `decide_approval` (SPEC-003). */
export const DecideApprovalInputSchema = z.strictObject({
  orderId: z.string(),
  proposalVersion,
  decision: z.enum(DECISIONS),
  next: NextSchema.optional(),
  note: z.string().optional(),
  changes: z.array(LineChangeSchema).optional(),
  offerId: z.string().optional(),
  maxOrderTotal: z.number().nonnegative().optional(),
});
export type DecideApprovalInput = z.infer<typeof DecideApprovalInputSchema>;
