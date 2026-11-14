import {
  type AuditEvent,
  type ErrorCode,
  type Evaluation,
  type Mandate,
  type OfferClaims,
  type OrderLine,
  type PlaceOrderRequest,
  type Precheck,
  type Principal,
  REASON_TEXT,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { evaluate, grossTotal, nextDeliveryDateAfterCutoff, netTotal } from "../domain/evaluate.ts";
import { commitPlacement } from "./commit-placement.ts";
import type {
  MandatePort,
  OfferVerifier,
  OrderStore,
  OrderTx,
  PaymentPort,
  StoredOrder,
} from "./ports.ts";

export interface OrderDeps {
  store: OrderStore;
  verifyOffer: OfferVerifier;
  mandates: MandatePort;
  payment: PaymentPort;
  now: () => Date;
}

type RefusalCode = Extract<
  ErrorCode,
  "BAD_REQUEST" | "OFFER_INVALID" | "CONFLICT" | "STALE_OFFER" | "UPSTREAM_FAILED"
>;

export interface Refusal {
  code: RefusalCode;
  message: string;
}

const refusal = (code: RefusalCode, message: string): Refusal => ({ code, message });

/** The lines that passed SPEC-009 R1 and R3-R5, with the mandate they are checked against. */
interface Checked {
  lines: OrderLine[];
  alternatives: OrderLine[];
  mandate: Mandate | null;
}

const verifyAll = async (
  verifyOffer: OfferVerifier,
  tokens: string[],
  now: Date,
): Promise<Result<OrderLine[], Refusal>> => {
  const lines: OrderLine[] = [];
  for (const token of tokens) {
    const verified = await verifyOffer(token, now);
    let claims: OfferClaims;
    if (verified.ok) claims = verified.value;
    else if (verified.error.code === "OFFER_EXPIRED") claims = verified.error.claims;
    else return err(refusal("OFFER_INVALID", "An offer token failed verification."));
    lines.push({ offerId: claims.offerId, token, claims });
  }
  return ok(lines);
};

/** SPEC-009 R3-R5. Neither precheck nor place_order goes past a refusal. */
const checkTokens = async (
  deps: OrderDeps,
  principal: Principal,
  offers: string[],
  alternatives: string[],
  now: Date,
): Promise<Result<Checked, Refusal>> => {
  const all = [...offers, ...alternatives];
  if (new Set(all).size !== all.length)
    return err(refusal("OFFER_INVALID", "The request repeats an offer token."));
  const lines = await verifyAll(deps.verifyOffer, offers, now);
  if (!lines.ok) return lines;
  const alternativeLines = await verifyAll(deps.verifyOffer, alternatives, now);
  if (!alternativeLines.ok) return alternativeLines;

  const claims = [...lines.value, ...alternativeLines.value].map((line) => line.claims);
  if (claims.some((claim) => claim.customer !== principal.customer))
    return err(refusal("BAD_REQUEST", "An offer was issued to another customer."));
  if (new Set(lines.value.map((line) => line.claims.paymentTerms)).size > 1)
    return err(refusal("BAD_REQUEST", "The offers have different payment terms."));

  const mandate = await deps.mandates.current();
  if (!mandate.ok) return err(refusal("UPSTREAM_FAILED", "The mandate could not be read."));
  const current = mandate.value;
  const stale = claims.some(
    (claim) =>
      claim.agentId !== principal.agentId ||
      (current !== null &&
        (claim.mandateId !== current.mandateId || claim.mandateVersion !== current.version)),
  );
  if (stale)
    return err(
      refusal("STALE_OFFER", "The offers were made under another mandate; request new offers."),
    );
  return ok({ lines: lines.value, alternatives: alternativeLines.value, mandate: current });
};

const evaluateChecked = async (
  deps: OrderDeps,
  principal: Principal,
  checked: Checked,
  now: Date,
): Promise<Evaluation> => {
  const claims = checked.lines.map((line) => line.claims);
  const history = await deps.store.history(principal.customer, [
    ...new Set(claims.map((claim) => claim.productId)),
  ]);
  return evaluate({ claims, mandate: checked.mandate, history, live: null, now });
};

/** Runs R3-R5 and the rule checks without writing anything and without the credit check. */
export const precheck = async (
  deps: OrderDeps,
  principal: Principal,
  offers: string[],
): Promise<Result<Precheck, Refusal>> => {
  const now = deps.now();
  const checked = await checkTokens(deps, principal, offers, [], now);
  if (!checked.ok) return checked;
  return ok(await evaluateChecked(deps, principal, checked.value, now));
};

const sameTokens = (order: StoredOrder, request: PlaceOrderRequest): boolean =>
  JSON.stringify(order.requested) ===
  JSON.stringify({ offers: request.offers, alternatives: request.alternatives ?? [] });

const replayOrConflict = (
  order: StoredOrder,
  request: PlaceOrderRequest,
): Result<{ order: StoredOrder; created: false }, Refusal> =>
  sameTokens(order, request)
    ? ok({ order, created: false })
    : err(refusal("CONFLICT", "The idempotency key was used with other offers."));

const auditOf = (evaluation: Evaluation, at: string): AuditEvent[] => {
  const opened: AuditEvent[] = [
    { at, actor: "agent", event: "order_requested" },
    { at, actor: "server", event: "offer_verified" },
  ];
  if (evaluation.decision === "auto")
    return [...opened, { at, actor: "server", event: "check_passed" }];
  const failed: AuditEvent[] = evaluation.reasons.map((reason) => ({
    at,
    actor: "server",
    event: "check_failed",
    reason,
    detail: REASON_TEXT[reason],
  }));
  const outcome: AuditEvent =
    evaluation.decision === "rejected"
      ? { at, actor: "server", event: "rejected" }
      : { at, actor: "server", event: "sent_to_approval" };
  return [...opened, ...failed, outcome];
};

const buildOrder = (
  principal: Principal,
  request: PlaceOrderRequest,
  checked: Checked,
  evaluation: Evaluation,
  now: Date,
): StoredOrder => {
  const claims = checked.lines.map((line) => line.claims);
  const at = now.toISOString();
  return {
    orderId: `ord_${crypto.randomUUID()}`,
    customer: principal.customer,
    agentId: principal.agentId,
    accountId: principal.accountId,
    idempotencyKey: request.idempotencyKey,
    requested: { offers: request.offers, alternatives: request.alternatives ?? [] },
    offerIds: checked.lines.map((line) => line.offerId),
    lines: checked.lines,
    alternatives: checked.alternatives,
    mandateId: checked.mandate?.mandateId ?? null,
    mandateVersion: checked.mandate?.version ?? null,
    // An auto order is placed by commitPlacement before anyone can read it.
    status: evaluation.decision === "rejected" ? "rejected" : "pending_approval",
    reasons: evaluation.reasons,
    proposalVersion: 1,
    paymentTerms: claims[0]?.paymentTerms ?? principal.paymentTerms,
    total: { net: netTotal(claims), gross: grossTotal(claims) },
    originalRequest: request.originalRequest ?? null,
    decision: null,
    requotes: [],
    nextDeliveryDate: evaluation.reasons.includes("CUTOFF_PASSED")
      ? nextDeliveryDateAfterCutoff(claims, now)
      : null,
    audit: auditOf(evaluation, at),
    createdAt: at,
  };
};

const refuse = async (
  store: OrderStore,
  principal: Principal,
  error: Refusal,
  now: Date,
): Promise<Result<never, Refusal>> => {
  // An unreachable mandate service is not a refusal of the request (SPEC-009 R3-R6).
  if (error.code !== "UPSTREAM_FAILED")
    await store.refuse(principal.customer, {
      at: now.toISOString(),
      actor: "agent",
      event: "order_refused",
      detail: error.code,
    });
  return err(error);
};

/**
 * SPEC-009 R2-R5, then the rule checks. The order is stored with every reason; an order without
 * reasons is placed through commitPlacement in the same transaction.
 */
export const placeOrder = async (
  deps: OrderDeps,
  principal: Principal,
  request: PlaceOrderRequest,
): Promise<Result<{ order: StoredOrder; created: boolean }, Refusal>> => {
  const known = await deps.store.findByKey(principal.customer, request.idempotencyKey);
  if (known !== null) return replayOrConflict(known, request);

  const now = deps.now();
  const checked = await checkTokens(
    deps,
    principal,
    request.offers,
    request.alternatives ?? [],
    now,
  );
  if (!checked.ok) return refuse(deps.store, principal, checked.error, now);
  const evaluation = await evaluateChecked(deps, principal, checked.value, now);
  const order = buildOrder(principal, request, checked.value, evaluation, now);

  return deps.store.withCustomerLock(principal.customer, async (tx: OrderTx) => {
    // A parallel request with the same key may have stored its order while this one was checked.
    const stored = await tx.findByKey(principal.customer, request.idempotencyKey);
    if (stored !== null) return replayOrConflict(stored, request);
    const final =
      evaluation.decision === "auto"
        ? await commitPlacement({
            tx,
            order,
            creditLimit: principal.creditLimit,
            payment: deps.payment,
            now,
          })
        : order;
    await tx.insert(final);
    return ok({ order: final, created: true });
  });
};

export const findOrder = (
  store: OrderStore,
  principal: Principal,
  orderId: string,
): Promise<StoredOrder | null> => store.find(principal.customer, orderId);
