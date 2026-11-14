import {
  type AuditEvent,
  type DecideApprovalRequest,
  type ErrorCode,
  type Evaluation,
  type Mandate,
  type OfferClaims,
  type OrderLine,
  type Principal,
  REASON_TEXT,
  type Requote,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { grossTotal, netTotal, nextDeliveryDateAfterCutoff } from "../domain/evaluate.ts";
import { commitPlacement } from "./commit-placement.ts";
import { auditOf, checkTokens, evaluateChecked, type OrderDeps } from "./orders.ts";
import type { OrderTx, RequotePort, StoredOrder } from "./ports.ts";

type DecisionErrorCode = Extract<
  ErrorCode,
  | "BAD_REQUEST"
  | "OFFER_INVALID"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_OFFER"
  | "OFFER_EXPIRED"
  | "NOT_IMPLEMENTED"
  | "UPSTREAM_FAILED"
>;

export interface ApprovalDeps extends OrderDeps {
  offers: RequotePort;
}

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

const isExpired = (lines: OrderLine[], now: Date): boolean =>
  lines.some((line) => line.claims.exp <= Math.floor(now.getTime() / 1000));

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
  if (isExpired(order.lines, now))
    return failure("OFFER_EXPIRED", "An offer of this order has expired.");
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

type Revision = Extract<DecideApprovalRequest, { decision: "edit" | "pick_alternative" }>;

/** One line of a proposed revision: the line it takes the place of (null when added), and its token. */
interface Proposed {
  previous: OrderLine | null;
  token: string;
}

const isOpen = (order: StoredOrder, proposalVersion: number): boolean =>
  order.status === "pending_approval" && order.proposalVersion === proposalVersion;

const changed = (): Result<never, DecisionError> =>
  failure("CONFLICT", "The order was decided or changed; reload it.");

/**
 * Edit: a new offer for every line through `requote`, with the approver's changes, so no line keeps
 * an old price, date or mandate. Each fresh offer is matched to its line by product and by the
 * product it replaces.
 */
const edited = async (
  offers: RequotePort,
  order: StoredOrder,
  changes: Extract<Revision, { decision: "edit" }>["changes"],
): Promise<Result<Proposed[], DecisionError>> => {
  const products = new Set(order.lines.map((line) => line.claims.productId));
  if (changes.some((change) => !products.has(change.productId)))
    return failure("BAD_REQUEST", "A change names a product that the order does not hold.");
  if (changes.some((change) => change.quantity !== undefined && change.quantity.value <= 0))
    return failure(
      "BAD_REQUEST",
      "Removing a product is not available; change its amount or reject the order.",
    );
  const result = await offers.requote({ tokens: order.lines.map((line) => line.token), changes });
  if (!result.ok)
    return result.error === "BAD_REQUEST"
      ? failure("BAD_REQUEST", "The offers refused the change.")
      : failure("UPSTREAM_FAILED", "The offers could not be re-quoted.");
  const fresh = [...result.value.offers];
  const proposed: Proposed[] = [];
  for (const line of order.lines) {
    const index = fresh.findIndex(
      (offer) =>
        offer.claims.productId === line.claims.productId &&
        offer.claims.replaces === line.claims.replaces,
    );
    const offer = fresh[index];
    if (offer === undefined) {
      const omitted = result.value.omitted.find(
        (entry) => entry.productId === line.claims.productId,
      );
      return failure(
        "STALE_OFFER",
        `${line.claims.product.name} could not be offered again: ${omitted?.detail ?? "no offer"}.`,
      );
    }
    fresh.splice(index, 1);
    proposed.push({ previous: line, token: offer.token });
  }
  return ok(proposed);
};

/**
 * Pick an alternative: it takes the place of the line it competes with. A substitute replaces the
 * line that substitutes the same product, or is added for the shortfall when there is none; an
 * offer of the same product replaces that product's line.
 */
const picked = (order: StoredOrder, offerId: string): Result<Proposed[], DecisionError> => {
  const alternative = order.alternatives.find((line) => line.offerId === offerId);
  if (alternative === undefined)
    return failure("BAD_REQUEST", "The order holds no such alternative.");
  const { replaces, productId } = alternative.claims;
  const swapped = order.lines.findIndex((line) =>
    replaces === null ? line.claims.productId === productId : line.claims.replaces === replaces,
  );
  const kept = order.lines.map((line): Proposed => ({ previous: line, token: line.token }));
  if (swapped !== -1)
    return ok(
      kept.with(swapped, { previous: order.lines[swapped] ?? null, token: alternative.token }),
    );
  if (replaces !== null && order.lines.some((line) => line.claims.productId === replaces))
    return ok([...kept, { previous: null, token: alternative.token }]);
  return failure("BAD_REQUEST", "The alternative takes the place of no line of the order.");
};

const change = (previous: OfferClaims, current: OfferClaims): string => {
  const name =
    previous.productId === current.productId
      ? current.product.name
      : `${previous.product.name} → ${current.product.name}`;
  const amount =
    previous.quantity.value === current.quantity.value
      ? `${current.quantity.value} ${current.quantity.unit}`
      : `${previous.quantity.value} → ${current.quantity.value} ${current.quantity.unit}`;
  const date =
    previous.deliveryDate === current.deliveryDate
      ? ""
      : `, delivery ${previous.deliveryDate} → ${current.deliveryDate}`;
  return `${name}: ${amount}${date}`;
};

/**
 * The revised proposal: the new lines, every reason of the new check, `proposalVersion` + 1, one
 * `Requote` per replaced line (it keeps the replaced offer ID consumed, SPEC-009) and an `edited`
 * event per change, then the check events.
 */
const revision = (input: {
  principal: Principal;
  order: StoredOrder;
  request: Revision;
  proposed: Proposed[];
  lines: OrderLine[];
  alternatives: OrderLine[];
  mandate: Mandate | null;
  evaluation: Evaluation;
  now: Date;
}): StoredOrder => {
  const { principal, order, request, proposed, lines, alternatives, mandate, evaluation, now } =
    input;
  const at = now.toISOString();
  const pairs = lines.flatMap((line, index) => {
    const previous = proposed[index]?.previous ?? null;
    return previous?.offerId === line.offerId ? [] : [{ previous, current: line }];
  });
  const requotes: Requote[] = pairs.flatMap(({ previous, current }) =>
    previous === null
      ? []
      : [{ at, previous: previous.claims, current: current.claims, reasons: evaluation.reasons }],
  );
  const edits = pairs.map(({ previous, current }) =>
    approverEvent(at, "edited", {
      detail:
        previous === null
          ? `${current.claims.product.name}: added`
          : change(previous.claims, current.claims),
    }),
  );
  const checks = auditOf(evaluation, at).filter((event) => event.event !== "order_requested");
  const claims = lines.map((line) => line.claims);
  return {
    ...order,
    offerIds: lines.map((line) => line.offerId),
    lines,
    alternatives,
    mandateId: mandate?.mandateId ?? null,
    mandateVersion: mandate?.version ?? null,
    // An order with no reason left is placed by commitPlacement before anyone can read it.
    status: evaluation.decision === "rejected" ? "rejected" : "pending_approval",
    reasons: evaluation.reasons,
    proposalVersion: order.proposalVersion + 1,
    total: { net: netTotal(claims), gross: grossTotal(claims) },
    decision:
      evaluation.decision === "needs_approval"
        ? order.decision
        : { action: request.decision, next: null, note: null, by: principal.accountId, at },
    requotes: [...order.requotes, ...requotes],
    nextDeliveryDate: evaluation.reasons.includes("CUTOFF_PASSED")
      ? nextDeliveryDateAfterCutoff(claims, now)
      : null,
    audit: [...order.audit, ...edits, ...checks],
  };
};

/**
 * Edit and pick_alternative (SPEC-011): the new lines go through every token check and every rule of
 * SPEC-009 again. A reason keeps the order pending as the next proposal; none places it through
 * commitPlacement; a rejecting reason rejects it. An edit can never skip a check.
 */
const revise = async (
  deps: ApprovalDeps,
  principal: Principal,
  known: StoredOrder,
  request: Revision,
): Promise<Result<StoredOrder, DecisionError>> => {
  if (!isOpen(known, request.proposalVersion)) return changed();
  const proposal =
    request.decision === "edit"
      ? await edited(deps.offers, known, request.changes)
      : picked(known, request.offerId);
  if (!proposal.ok) return proposal;
  const tokens = proposal.value.map((line) => line.token);
  const alternatives = known.alternatives.filter((line) => !tokens.includes(line.token));
  const now = deps.now();
  const checked = await checkTokens(
    deps,
    principal,
    tokens,
    alternatives.map((line) => line.token),
    now,
  );
  if (!checked.ok) return failure(checked.error.code, checked.error.message);
  if (isExpired(checked.value.lines, now))
    return failure("OFFER_EXPIRED", "An offer of this order has expired.");
  const evaluation = await evaluateChecked(deps, principal, checked.value, now);

  return deps.store.withCustomerLock(principal.customer, async (tx) => {
    const order = await tx.find(principal.customer, known.orderId);
    if (order === null) return failure("NOT_FOUND", "No such order.");
    if (!isOpen(order, request.proposalVersion)) return changed();
    const added = checked.value.lines
      .map((line) => line.offerId)
      .filter((offerId) => !order.offerIds.includes(offerId));
    if (await tx.hasUsedOffers(principal.customer, added))
      return failure("OFFER_INVALID", "An offer has already been used in an order.");
    const revised = revision({
      principal,
      order,
      request,
      proposed: proposal.value,
      ...checked.value,
      evaluation,
      now,
    });
    const final =
      evaluation.decision === "auto"
        ? await commitPlacement({
            tx,
            order: revised,
            creditLimit: principal.creditLimit,
            payment: deps.payment,
            now,
          })
        : revised;
    if (!(await tx.decide(final, request.proposalVersion))) return changed();
    return ok(final);
  });
};

/**
 * A human decision on a pending order. Approve and remember answers NOT_IMPLEMENTED. The decision
 * is written only if the order is still pending at the request's proposalVersion, under the
 * customer's placement lock.
 */
export const decide = async (
  deps: ApprovalDeps,
  principal: Principal,
  orderId: string,
  request: DecideApprovalRequest,
): Promise<Result<StoredOrder, DecisionError>> => {
  if (request.decision === "approve_and_remember")
    return failure("NOT_IMPLEMENTED", "This decision is not available yet.");
  const known = await deps.store.find(principal.customer, orderId);
  if (known === null) return failure("NOT_FOUND", "No such order.");
  if (request.decision === "edit" || request.decision === "pick_alternative")
    return revise(deps, principal, known, request);

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
    if (!isOpen(order, request.proposalVersion)) return changed();
    const decided =
      request.decision === "approve"
        ? await approve(deps, principal, tx, order, mandate, now)
        : ok(reject(principal, order, request, now));
    if (!decided.ok) return decided;
    if (!(await tx.decide(decided.value, request.proposalVersion))) return changed();
    return decided;
  });
};
