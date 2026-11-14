import {
  type AuditEvent,
  type DecideApprovalRequest,
  type ErrorCode,
  type Mandate,
  type Principal,
  REASON_TEXT,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { commitPlacement } from "./commit-placement.ts";
import type { OrderDeps } from "./orders.ts";
import type { OrderTx, StoredOrder } from "./ports.ts";

type DecisionErrorCode = Extract<
  ErrorCode,
  "NOT_FOUND" | "CONFLICT" | "STALE_OFFER" | "OFFER_EXPIRED" | "NOT_IMPLEMENTED" | "UPSTREAM_FAILED"
>;

export interface DecisionError {
  code: DecisionErrorCode;
  message: string;
}

const failure = (code: DecisionErrorCode, message: string): Result<never, DecisionError> =>
  err({ code, message });

export const listPending = (deps: OrderDeps, principal: Principal): Promise<StoredOrder[]> =>
  deps.store.pending(principal.customer);

const approverEvent = (
  at: string,
  event: AuditEvent["event"],
  extra: Omit<AuditEvent, "at" | "actor" | "event"> = {},
): AuditEvent => ({ at, actor: "approver", event, ...extra });

const isExpired = (order: StoredOrder, now: Date): boolean =>
  order.lines.some((line) => line.claims.exp <= Math.floor(now.getTime() / 1000));

const madeUnderOtherMandate = (order: StoredOrder, mandate: Mandate): boolean =>
  order.lines.some(
    (line) =>
      line.claims.mandateId !== mandate.mandateId || line.claims.mandateVersion !== mandate.version,
  );

/**
 * Approve: re-checks the order against the current mandate of its agent and the offers' expiry,
 * then places it through commitPlacement, which runs the credit and payment steps (SPEC-010,
 * SPEC-011). Without re-quote, a differing mandate or an expired offer leaves the order pending.
 */
const approve = async (
  deps: OrderDeps,
  principal: Principal,
  tx: OrderTx,
  order: StoredOrder,
  mandate: Mandate | null,
  now: Date,
): Promise<Result<StoredOrder, DecisionError>> => {
  const at = now.toISOString();
  const decided: StoredOrder = {
    ...order,
    decision: { action: "approve", next: null, note: null, by: principal.accountId, at },
    audit: [...order.audit, approverEvent(at, "approved")],
  };
  if (mandate === null)
    return ok({
      ...decided,
      status: "rejected",
      reasons: [...order.reasons, "MANDATE_INVALID"],
      audit: [
        ...decided.audit,
        {
          at,
          actor: "server",
          event: "check_failed",
          reason: "MANDATE_INVALID",
          detail: REASON_TEXT.MANDATE_INVALID,
        },
        { at, actor: "server", event: "rejected", reason: "MANDATE_INVALID" },
      ],
    });
  if (madeUnderOtherMandate(order, mandate))
    return failure("STALE_OFFER", "The mandate changed since the offers were made.");
  if (isExpired(order, now)) return failure("OFFER_EXPIRED", "An offer of this order has expired.");
  return ok(
    await commitPlacement({
      tx,
      order: decided,
      creditLimit: principal.creditLimit,
      payment: deps.payment,
      now,
    }),
  );
};

const reject = (
  principal: Principal,
  order: StoredOrder,
  request: Extract<DecideApprovalRequest, { decision: "reject" }>,
  now: Date,
): StoredOrder => {
  const at = now.toISOString();
  const note = request.note ?? null;
  return {
    ...order,
    status: "declined",
    decision: { action: "reject", next: request.next, note, by: principal.accountId, at },
    audit: [...order.audit, approverEvent(at, "declined", note === null ? {} : { detail: note })],
  };
};

/**
 * A human decision on a pending order. Only approve and reject are built; the other decisions
 * answer NOT_IMPLEMENTED. The decision is written only if the order is still pending at the
 * request's proposalVersion, under the customer's placement lock.
 */
export const decide = async (
  deps: OrderDeps,
  principal: Principal,
  orderId: string,
  request: DecideApprovalRequest,
): Promise<Result<StoredOrder, DecisionError>> => {
  if (request.decision !== "approve" && request.decision !== "reject")
    return failure("NOT_IMPLEMENTED", "This decision is not available yet.");
  const known = await deps.store.find(principal.customer, orderId);
  if (known === null) return failure("NOT_FOUND", "No such order.");

  // Read before the lock: the mandates service is another HTTP call.
  let mandate: Mandate | null = null;
  if (request.decision === "approve") {
    const current = await deps.mandates.current(known.agentId);
    if (!current.ok) return failure("UPSTREAM_FAILED", "The mandate could not be read.");
    mandate = current.value;
  }

  const now = deps.now();
  return deps.store.withCustomerLock(principal.customer, async (tx) => {
    const order = await tx.find(principal.customer, orderId);
    if (order === null) return failure("NOT_FOUND", "No such order.");
    if (order.status !== "pending_approval" || order.proposalVersion !== request.proposalVersion)
      return failure("CONFLICT", "The order was decided or changed; reload it.");
    const decided =
      request.decision === "approve"
        ? await approve(deps, principal, tx, order, mandate, now)
        : ok(reject(principal, order, request, now));
    if (!decided.ok) return decided;
    if (!(await tx.decide(decided.value, request.proposalVersion)))
      return failure("CONFLICT", "The order was decided or changed; reload it.");
    return decided;
  });
};
