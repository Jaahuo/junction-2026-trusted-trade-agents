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
  type ReasonCode,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import {
  evaluate,
  grossTotal,
  nextDeliveryDateAfterCutoff,
  netTotal,
  reasonsByProduct,
  ruleFor,
} from "../domain/evaluate.ts";
import { appendOrderAudit, commitPlacement } from "./commit-placement.ts";
import type {
  MandatePort,
  OfferVerifier,
  OrderStore,
  OrderTx,
  PaymentPort,
  ReceiptSigner,
  StoredOrder,
} from "./ports.ts";

export interface OrderDeps {
  store: OrderStore;
  verifyOffer: OfferVerifier;
  mandates: MandatePort;
  payment: PaymentPort;
  signReceipt: ReceiptSigner;
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

/** SPEC-009 R3-R5, plus the payment terms of SPEC-002. Neither precheck nor place_order goes past a refusal. */
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
  if (new Set(claims.map((claim) => claim.offerId)).size !== claims.length)
    return err(refusal("OFFER_INVALID", "The request repeats an offer ID."));
  if (claims.some((claim) => claim.customer !== principal.customer))
    return err(refusal("BAD_REQUEST", "An offer was issued to another customer."));
  // Every token, alternatives included, must carry the account's payment terms; so they also agree.
  if (claims.some((claim) => claim.paymentTerms !== principal.paymentTerms))
    return err(refusal("BAD_REQUEST", "The offers' payment terms are not the account's."));

  const mandate = await deps.mandates.current(principal.agentId);
  if (!mandate.ok) return err(refusal("UPSTREAM_FAILED", "The mandate could not be read."));
  // A mandate signed for another agent or customer is not this principal's mandate.
  const current =
    mandate.value !== null &&
    mandate.value.agent === principal.agentId &&
    mandate.value.iss === principal.customer
      ? mandate.value
      : null;
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

/** The evaluation, and the reasons each product raises (for the audit). */
type Evaluated = { evaluation: Evaluation; byProduct: Map<string, ReasonCode[]> };

const evaluateChecked = async (
  deps: OrderDeps,
  principal: Principal,
  checked: Checked,
  now: Date,
): Promise<Evaluated> => {
  const claims = checked.lines.map((line) => line.claims);
  const history = await deps.store.history(principal.customer, [
    ...new Set(claims.map((claim) => claim.productId)),
  ]);
  return {
    evaluation: evaluate({ claims, mandate: checked.mandate, history, live: null, now }),
    byProduct: reasonsByProduct(claims, checked.mandate, history),
  };
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
  return ok((await evaluateChecked(deps, principal, checked.value, now)).evaluation);
};

const sameTokens = (order: StoredOrder, request: PlaceOrderRequest): boolean =>
  JSON.stringify(order.requested.offers) === JSON.stringify(request.offers) &&
  JSON.stringify(order.requested.alternatives) === JSON.stringify(request.alternatives ?? []) &&
  order.requested.supersedes?.orderId === request.supersedes?.orderId &&
  order.requested.supersedes?.proposalVersion === request.supersedes?.proposalVersion;

const replayOrConflict = (
  order: StoredOrder,
  request: PlaceOrderRequest,
): Result<{ order: StoredOrder; created: false }, Refusal> =>
  sameTokens(order, request)
    ? ok({ order, created: false })
    : err(refusal("CONFLICT", "The idempotency key was used with other offers."));

/**
 * The audit of a new order. A reason about one product gets one check_failed per product, with
 * its productId, so the approval card can name the product.
 */
const auditOf = (
  evaluation: Evaluation,
  byProduct: Map<string, ReasonCode[]>,
  checked: Pick<Checked, "lines" | "mandate">,
  at: string,
): AuditEvent[] => {
  const standing: AuditEvent[] = checked.lines.flatMap(({ claims }) => {
    const rule = checked.mandate === null ? undefined : ruleFor(checked.mandate.limits, claims);
    if (rule?.policy !== "auto") return [];
    return [
      {
        at,
        actor: "server",
        event: "check_passed",
        productId: claims.productId,
        detail: `Substitute allowed without asking: standing approval given ${rule.decidedAt.slice(0, 10)}.`,
      },
    ];
  });
  const opened: AuditEvent[] = [
    { at, actor: "agent", event: "order_requested" },
    { at, actor: "server", event: "offer_verified" },
    ...standing,
  ];
  if (evaluation.decision === "auto")
    return [...opened, { at, actor: "server", event: "check_passed" }];
  const failed = evaluation.reasons.flatMap((reason) => {
    const failedFor = (productId?: string): AuditEvent => ({
      at,
      actor: "server",
      event: "check_failed",
      reason,
      detail: REASON_TEXT[reason],
      ...(productId === undefined ? {} : { productId }),
    });
    const products = [...byProduct].filter(([, reasons]) => reasons.includes(reason));
    return products.length === 0
      ? [failedFor()]
      : products.map(([productId]) => failedFor(productId));
  });
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
  { evaluation, byProduct }: Evaluated,
  now: Date,
): StoredOrder => {
  const claims = checked.lines.map((line) => line.claims);
  const at = now.toISOString();
  const audit = auditOf(evaluation, byProduct, checked, at);
  const requested = audit[0];
  if (requested !== undefined && request.supersedes !== undefined)
    requested.detail = `Replaces ${request.supersedes.orderId} proposal ${request.supersedes.proposalVersion}`;
  return {
    orderId: `ord_${crypto.randomUUID()}`,
    customer: principal.customer,
    agentId: principal.agentId,
    accountId: principal.accountId,
    idempotencyKey: request.idempotencyKey,
    requested: {
      offers: request.offers,
      alternatives: request.alternatives ?? [],
      ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
    },
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
    audit,
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
  if (error.code !== "UPSTREAM_FAILED") {
    const recorded = await store.refuse(principal.customer, {
      at: now.toISOString(),
      actor: "agent",
      event: "order_refused",
      detail: error.code,
    });
    if (!recorded.ok)
      return err(refusal("UPSTREAM_FAILED", "The audit record could not be verified."));
  }
  return err(error);
};

const replacementPredecessor = async (
  tx: OrderTx,
  principal: Principal,
  supersedes: PlaceOrderRequest["supersedes"],
): Promise<Result<StoredOrder | null, Refusal>> => {
  if (supersedes === undefined) return ok(null);
  const previous = await tx.find(principal.customer, supersedes.orderId);
  if (
    previous === null ||
    previous.agentId !== principal.agentId ||
    previous.accountId !== principal.accountId ||
    previous.status !== "pending_approval" ||
    previous.proposalVersion !== supersedes.proposalVersion
  )
    return err(refusal("CONFLICT", "The proposal to replace is not pending or has changed."));
  return ok(previous);
};

const closeReplacedProposal = (previous: StoredOrder, replacement: StoredOrder, now: Date) => {
  const at = now.toISOString();
  const detail = `Replaced by ${replacement.orderId}`;
  return appendOrderAudit(
    {
      ...previous,
      status: "declined",
      decision: { action: "reject", next: "stop", note: detail, by: "server", at },
    },
    [{ at, actor: "server", event: "declined", detail }],
  );
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
  const evaluated = await evaluateChecked(deps, principal, checked.value, now);
  const { evaluation } = evaluated;
  const unchained = buildOrder(principal, request, checked.value, evaluated, now);
  const chained = await appendOrderAudit(unchained, unchained.audit, true);
  if (!chained.ok)
    return err(refusal("UPSTREAM_FAILED", "The audit record could not be verified."));
  const order = chained.value;

  const result = await deps.store.withCustomerLock(principal.customer, async (tx: OrderTx) => {
    // A parallel request with the same key may have stored its order while this one was checked.
    const stored = await tx.findByKey(principal.customer, request.idempotencyKey);
    if (stored !== null) return replayOrConflict(stored, request);
    if (
      await tx.hasUsedOffers(
        principal.customer,
        checked.value.lines.map((line) => line.offerId),
      )
    )
      return err(refusal("OFFER_INVALID", "An offer has already been used in an order."));
    const predecessor = await replacementPredecessor(tx, principal, request.supersedes);
    if (!predecessor.ok) return predecessor;
    const closed =
      predecessor.value === null
        ? null
        : await closeReplacedProposal(predecessor.value, order, now);
    if (closed !== null && !closed.ok)
      return err(refusal("UPSTREAM_FAILED", "The earlier proposal's audit could not be verified."));
    const final =
      evaluation.decision === "auto"
        ? await commitPlacement({
            tx,
            order,
            creditLimit: principal.creditLimit,
            payment: deps.payment,
            signReceipt: deps.signReceipt,
            now,
          })
        : ok(order);
    if (!final.ok) return err(refusal("UPSTREAM_FAILED", "The order could not be finalized."));
    if (final.value.status !== "rejected" && closed !== null && closed.ok) {
      if (!(await tx.decide(closed.value, closed.value.proposalVersion)))
        throw new Error("The replacement proposal changed under the customer's lock.");
    }
    await tx.insert(final.value);
    return ok({ order: final.value, created: true });
  });
  if (!result.ok && result.error.code === "OFFER_INVALID")
    return refuse(deps.store, principal, result.error, now);
  return result;
};

export const findOrder = (
  store: OrderStore,
  principal: Principal,
  orderId: string,
): Promise<StoredOrder | null> => store.find(principal.customer, orderId);

// Shared with approvals: edit and pick_alternative run these checks again (SPEC-011).
export { auditOf, checkTokens, evaluateChecked, type Evaluated };
