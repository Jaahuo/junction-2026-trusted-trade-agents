import {
  type AuditEvent,
  type DecideApprovalRequest,
  type ErrorCode,
  type Mandate,
  type Principal,
  REASON_TEXT,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { ruleFor } from "../domain/evaluate.ts";
import { appendOrderAudit, commitPlacement } from "./commit-placement.ts";
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
  const approved = await appendOrderAudit(
    {
      ...order,
      decision: { action: "approve", next: null, note: null, by: principal.accountId, at },
    },
    [approverEvent(at, "approved")],
  );
  if (!approved.ok) return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
  const decided = approved.value;
  if (mandate === null) {
    const rejected = await appendOrderAudit(
      {
        ...decided,
        status: "rejected",
        reasons: [...order.reasons, "MANDATE_INVALID"],
      },
      [
        {
          at,
          actor: "server",
          event: "check_failed",
          reason: "MANDATE_INVALID",
          detail: REASON_TEXT.MANDATE_INVALID,
        },
        { at, actor: "server", event: "rejected", reason: "MANDATE_INVALID" },
      ],
    );
    return rejected.ok
      ? ok(rejected.value)
      : failure("UPSTREAM_FAILED", "The audit record could not be verified.");
  }
  if (madeUnderOtherMandate(order, mandate))
    return failure("STALE_OFFER", "The mandate changed since the offers were made.");
  if (isExpired(order, now)) return failure("OFFER_EXPIRED", "An offer of this order has expired.");
  const placed = await commitPlacement({
    tx,
    order: decided,
    creditLimit: principal.creditLimit,
    payment: deps.payment,
    signReceipt: deps.signReceipt,
    now,
  });
  return placed.ok
    ? ok(placed.value)
    : failure("UPSTREAM_FAILED", "The order could not be finalized.");
};

const reject = async (
  principal: Principal,
  order: StoredOrder,
  request: Extract<DecideApprovalRequest, { decision: "reject" }>,
  now: Date,
): Promise<Result<StoredOrder, DecisionError>> => {
  const at = now.toISOString();
  const note = request.note ?? null;
  const declined = await appendOrderAudit(
    {
      ...order,
      status: "declined",
      decision: { action: "reject", next: request.next, note, by: principal.accountId, at },
    },
    [approverEvent(at, "declined", note === null ? {} : { detail: note })],
  );
  return declined.ok
    ? ok(declined.value)
    : failure("UPSTREAM_FAILED", "The audit record could not be verified.");
};

/** Approvals of one substitute pair after which the card offers to stop asking. */
const STANDING_OFFER_AFTER = 3;

/**
 * The first substitute line of an approved order that has no rule yet, with how often the human
 * has approved that pair; set once the count reaches STANDING_OFFER_AFTER.
 */
const standingOffer = async (
  tx: OrderTx,
  order: StoredOrder,
  mandate: Mandate | null,
): Promise<StoredOrder["standingOffer"]> => {
  if (mandate === null || mandate.limits.substitutions !== "ask") return undefined;
  if (order.status !== "placed" && order.status !== "awaiting_payment") return undefined;
  const line = order.lines.find(
    ({ claims }) => claims.replaces !== null && ruleFor(mandate.limits, claims) === undefined,
  );
  if (line === undefined || line.claims.replaces === null) return undefined;
  const pair = { replaces: line.claims.replaces, productId: line.claims.productId };
  const approved = (await tx.withPair(order.customer, pair)).filter(
    (past) => past.decision?.action === "approve",
  );
  if (approved.length < STANDING_OFFER_AFTER) return undefined;
  const replacesName = approved
    .flatMap((past) => past.lines)
    .find(({ claims }) => claims.productId === pair.replaces)?.claims.product.name;
  return {
    ...pair,
    timesApproved: approved.length,
    ...(replacesName === undefined ? {} : { replacesName }),
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
    const verified = await appendOrderAudit(order, []);
    if (!verified.ok) return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    const decided =
      request.decision === "approve"
        ? await approve(deps, principal, tx, order, mandate, now)
        : await reject(principal, order, request, now);
    if (!decided.ok) return decided;
    if (!(await tx.decide(decided.value, request.proposalVersion)))
      return failure("CONFLICT", "The order was decided or changed; reload it.");
    if (request.decision !== "approve" || !order.reasons.includes("SUBSTITUTION")) return decided;
    const offer = await standingOffer(tx, decided.value, mandate);
    return offer === undefined ? decided : ok({ ...decided.value, standingOffer: offer });
  });
};
