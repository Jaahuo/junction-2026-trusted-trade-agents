import {
  type AuditEvent,
  type DecideApprovalRequest,
  type ErrorCode,
  type Mandate,
  type OfferClaims,
  type OffersResult,
  type OmitReason,
  type OrderLine,
  type Principal,
  REASON_TEXT,
  type ReasonCode,
  type Requote,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { grossTotal, netTotal } from "../domain/evaluate.ts";
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

/** Thrown inside the placement transaction when the guarded write finds the order changed, so
 * everything written before it (history rows, the payment step) rolls back. */
class ChangedMeanwhile extends Error {}

/** Runs `work` under the customer's lock; a ChangedMeanwhile rolls it back and answers 409. */
const underLock = async (
  deps: OrderDeps,
  customer: string,
  work: (tx: OrderTx) => Promise<Result<StoredOrder, DecisionError>>,
): Promise<Result<StoredOrder, DecisionError>> => {
  try {
    return await deps.store.withCustomerLock(customer, work);
  } catch (error) {
    if (error instanceof ChangedMeanwhile) return changed();
    throw error;
  }
};

/** The guarded write: when the order is no longer pending at `proposalVersion`, roll back. */
const write = async (tx: OrderTx, order: StoredOrder, proposalVersion: number) => {
  if (!(await tx.decide(order, proposalVersion))) throw new ChangedMeanwhile();
};

/** A fault on the server's side (offers, signing keys), logged with the order it hit. */
const upstream = (orderId: string, message: string, detail: object = {}) => {
  console.error(message, { orderId, ...detail });
  return failure("UPSTREAM_FAILED", "The offers could not be re-quoted.");
};

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
type Changes = Extract<Revision, { decision: "edit" }>["changes"];
type Evaluated = Awaited<ReturnType<typeof evaluateChecked>>;

/** One line of a proposed revision: the line it takes the place of (null when added), and its token. */
interface Proposed {
  previous: OrderLine | null;
  token: string;
}

/** A line of the revision that is not on the order yet, and the line it takes the place of. */
interface Pair {
  previous: OrderLine | null;
  current: OrderLine;
}

const isOpen = (order: StoredOrder, proposalVersion: number): boolean =>
  order.status === "pending_approval" && order.proposalVersion === proposalVersion;

const changed = (): Result<never, DecisionError> =>
  failure("CONFLICT", "The order was decided or changed; reload it.");

/**
 * What an omitted line of a re-quote means. `refused`: the change asks for something the product
 * cannot be offered at. `unavailable`: the product cannot be supplied as asked now. `fault`: every
 * product comes back NO_PRICE when offers has no live price source.
 */
const OMIT_OUTCOME: Record<OmitReason, "refused" | "unavailable" | "fault"> = {
  INVALID_QUANTITY: "refused",
  CONSTRAINT_CONTRADICTED: "refused",
  UNKNOWN_PRODUCT: "refused",
  SALES_BLOCKED: "unavailable",
  INSUFFICIENT_STOCK: "unavailable",
  NO_DELIVERY_DATE: "unavailable",
  NO_PRICE: "fault",
};

/** The answer for a line the re-quote did not offer again, by the reason offers gave. */
const notOffered = (
  order: StoredOrder,
  line: OrderLine,
  omitted: OffersResult["omitted"],
  changes: Changes,
): Result<never, DecisionError> => {
  const { productId, product } = line.claims;
  const entry = omitted.find((candidate) => candidate.productId === productId);
  if (entry === undefined)
    return upstream(order.orderId, "The re-quote neither offered nor omitted a line.", {
      productId,
    });
  const outcome = OMIT_OUTCOME[entry.reason];
  if (outcome === "refused" && changes.some((change) => change.productId === productId))
    return failure(
      "BAD_REQUEST",
      `${product.name} cannot be offered with that change: ${entry.detail}.`,
    );
  if (outcome === "unavailable")
    return failure(
      "CONFLICT",
      `${product.name} cannot be offered again: ${entry.detail}. Change it or reject the order.`,
    );
  return upstream(order.orderId, "The re-quote omitted a line it should have offered.", {
    productId,
    reason: entry.reason,
    detail: entry.detail,
  });
};

/** The approver's changes, refused before offers is asked when they cannot apply to this order. */
const invalidChanges = (
  order: StoredOrder,
  changes: Changes,
): Result<never, DecisionError> | null => {
  const held = new Map<string, number>();
  for (const line of order.lines)
    held.set(line.claims.productId, (held.get(line.claims.productId) ?? 0) + 1);
  const named = changes.map((change) => change.productId);
  if (new Set(named).size !== named.length)
    return failure("BAD_REQUEST", "A product is changed more than once.");
  if (named.some((productId) => !held.has(productId)))
    return failure("BAD_REQUEST", "A change names a product that the order does not hold.");
  // Offers applies a change to every line of its product, so one line of several cannot be changed.
  if (named.some((productId) => (held.get(productId) ?? 0) > 1))
    return failure("BAD_REQUEST", "The order holds that product on more than one line.");
  if (changes.some((change) => change.quantity !== undefined && change.quantity.value <= 0))
    return failure(
      "BAD_REQUEST",
      "Removing a product is not available; change its amount or reject the order.",
    );
  return null;
};

/**
 * Edit: a new offer for every line through `requote`, with the approver's changes, so no line keeps
 * an old price, date or mandate. Each fresh offer is matched to its line by product and by the
 * product it replaces. An answer that does not fit the request is a fault of the offers side.
 */
const edited = async (
  offers: RequotePort,
  order: StoredOrder,
  changes: Changes,
): Promise<Result<Proposed[], DecisionError>> => {
  const invalid = invalidChanges(order, changes);
  if (invalid !== null) return invalid;
  const result = await offers.requote({ tokens: order.lines.map((line) => line.token), changes });
  // The changes were checked above, so a refusal by offers is a fault on the server's side too.
  if (!result.ok)
    return result.error === "BAD_REQUEST"
      ? upstream(order.orderId, "The offers refused a re-quote.", { code: result.error })
      : failure("UPSTREAM_FAILED", "The offers could not be re-quoted.");
  const used = new Set([
    ...order.offerIds,
    ...order.requotes.flatMap((entry) => [entry.previous.offerId, entry.current.offerId]),
  ]);
  const fresh = [...result.value.offers];
  const proposed: Proposed[] = [];
  for (const line of order.lines) {
    const index = fresh.findIndex(
      (offer) =>
        offer.claims.productId === line.claims.productId &&
        offer.claims.replaces === line.claims.replaces,
    );
    const offer = fresh[index];
    if (offer === undefined) return notOffered(order, line, result.value.omitted, changes);
    if (used.has(offer.claims.offerId))
      return upstream(order.orderId, "The re-quote returned an offer this order already used.", {
        offerId: offer.claims.offerId,
      });
    const asked = changes.find((change) => change.productId === line.claims.productId)?.quantity;
    if (
      asked !== undefined &&
      offer.claims.shortfall === null &&
      asked.unit === offer.claims.quantity.unit &&
      asked.value !== offer.claims.quantity.value
    )
      return upstream(order.orderId, "The re-quote did not apply the changed amount.", {
        productId: line.claims.productId,
      });
    fresh.splice(index, 1);
    proposed.push({ previous: line, token: offer.token });
  }
  if (fresh.length > 0)
    return upstream(order.orderId, "The re-quote returned offers that no line asked for.", {
      count: fresh.length,
    });
  return ok(proposed);
};

/**
 * Pick an alternative: it takes the place of the line it competes with. A substitute replaces the
 * line that substitutes the same product, or is added beside the line of the product it replaces;
 * an offer of the same product replaces that product's line.
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
      kept.map((line, index) =>
        index === swapped ? { previous: line.previous, token: alternative.token } : line,
      ),
    );
  if (replaces !== null && order.lines.some((line) => line.claims.productId === replaces))
    return ok([...kept, { previous: null, token: alternative.token }]);
  return failure("BAD_REQUEST", "The alternative takes the place of no line of the order.");
};

/** Each checked line that is new to the order, with the line it takes the place of, by token. */
const pairsOf = (proposed: Proposed[], lines: OrderLine[]): Pair[] => {
  const previousOf = new Map(proposed.map((line) => [line.token, line.previous]));
  return lines.flatMap((current) => {
    // checkTokens keeps every token it was given, so a line without a proposal is a bug.
    if (!previousOf.has(current.token)) throw new Error("A checked line matches no proposed line.");
    const previous = previousOf.get(current.token) ?? null;
    return previous?.offerId === current.offerId ? [] : [{ previous, current }];
  });
};

const cents = (value: number): number => Math.round(value * 100);
const unitGross = (claims: OfferClaims): number =>
  claims.unitPrice.net * (1 + claims.unitPrice.vatRate / 100);

/** The products whose re-quoted unit price is higher than the one the approver saw. */
const pricedUp = (pairs: Pair[]): string[] =>
  pairs.flatMap(({ previous, current }) =>
    previous !== null &&
    previous.claims.productId === current.claims.productId &&
    cents(unitGross(current.claims)) > cents(unitGross(previous.claims))
      ? [current.claims.productId]
      : [],
  );

/**
 * A higher price than the approver saw adds PRICE_CHANGED (SPEC-011), so the order waits for them
 * instead of being placed at a price nobody approved.
 */
const withPriceChanged = ({ evaluation, byProduct }: Evaluated, products: string[]): Evaluated => {
  if (products.length === 0) return { evaluation, byProduct };
  const reasons: ReasonCode[] = evaluation.reasons.includes("PRICE_CHANGED")
    ? evaluation.reasons
    : [...evaluation.reasons, "PRICE_CHANGED"];
  const marked = new Map(byProduct);
  for (const productId of products)
    marked.set(productId, [...(marked.get(productId) ?? []), "PRICE_CHANGED"]);
  return {
    evaluation: {
      decision: evaluation.decision === "rejected" ? "rejected" : "needs_approval",
      reasons,
    },
    byProduct: marked,
  };
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
  const price =
    cents(previous.unitPrice.net) === cents(current.unitPrice.net)
      ? ""
      : `, unit price ${previous.unitPrice.net} → ${current.unitPrice.net} EUR net`;
  return `${name}: ${amount}${date}${price}`;
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
  pairs: Pair[];
  lines: OrderLine[];
  alternatives: OrderLine[];
  mandate: Mandate | null;
  evaluated: Evaluated;
  now: Date;
}): StoredOrder => {
  const { principal, order, request, pairs, lines, alternatives, mandate, evaluated, now } = input;
  const { evaluation, byProduct } = evaluated;
  const at = now.toISOString();
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
  const checks = auditOf(evaluation, byProduct, at).filter(
    (event) => event.event !== "order_requested",
  );
  const claims = lines.map((line) => line.claims);
  return {
    ...order,
    offerIds: lines.map((line) => line.offerId),
    lines,
    alternatives,
    mandateId: mandate?.mandateId ?? null,
    mandateVersion: mandate?.version ?? null,
    // With no reason left the order goes through commitPlacement: placed, or rejected on credit.
    status: evaluation.decision === "rejected" ? "rejected" : "pending_approval",
    reasons: evaluation.reasons,
    proposalVersion: order.proposalVersion + 1,
    total: { net: netTotal(claims), gross: grossTotal(claims) },
    decision:
      evaluation.decision === "needs_approval"
        ? null
        : { action: request.decision, next: null, note: null, by: principal.accountId, at },
    requotes: [...order.requotes, ...requotes],
    audit: [...order.audit, ...edits, ...checks],
  };
};

/** Alternatives made under another mandate cannot be picked any more, so they are dropped. */
const underCurrentMandate = (
  order: StoredOrder,
  alternatives: OrderLine[],
  mandate: Mandate | null,
): OrderLine[] => {
  if (mandate === null) return alternatives;
  const kept = alternatives.filter(
    (line) =>
      line.claims.mandateId === mandate.mandateId && line.claims.mandateVersion === mandate.version,
  );
  if (kept.length !== alternatives.length)
    console.log("Alternatives made under another mandate were dropped.", {
      orderId: order.orderId,
      dropped: alternatives.length - kept.length,
    });
  return kept;
};

/**
 * Edit and pick_alternative (SPEC-011): the new lines go through every token check and the rules of
 * SPEC-009 again. An expired line is refused with 409 OFFER_EXPIRED and the order is unchanged. A
 * reason keeps the order pending as the next proposal, a rejecting reason rejects it, and none sends
 * it through commitPlacement. An edited line priced higher than before adds PRICE_CHANGED. An edit
 * can never skip a check.
 */
const revise = async (
  deps: ApprovalDeps,
  principal: Principal,
  known: StoredOrder,
  request: Revision,
): Promise<Result<StoredOrder, DecisionError>> => {
  if (!isOpen(known, request.proposalVersion)) return changed();
  const isEdit = request.decision === "edit";
  const proposal =
    request.decision === "edit"
      ? await edited(deps.offers, known, request.changes)
      : picked(known, request.offerId);
  if (!proposal.ok) return proposal;
  const tokens = proposal.value.map((line) => line.token);
  const now = deps.now();
  // The stored alternatives were checked when the order was placed; they are not offered again.
  const checked = await checkTokens(deps, principal, tokens, [], now);
  if (!checked.ok)
    return isEdit && checked.error.code === "OFFER_INVALID"
      ? upstream(known.orderId, "A re-quoted offer failed verification.", {
          message: checked.error.message,
        })
      : failure(checked.error.code, checked.error.message);
  if (isExpired(checked.value.lines, now))
    return failure("OFFER_EXPIRED", "An offer of this order has expired.");
  const alternatives = underCurrentMandate(
    known,
    known.alternatives.filter((line) => !tokens.includes(line.token)),
    checked.value.mandate,
  );
  const pairs = pairsOf(proposal.value, checked.value.lines);
  const checkedAgain = await evaluateChecked(deps, principal, checked.value, now);
  const evaluated = isEdit ? withPriceChanged(checkedAgain, pricedUp(pairs)) : checkedAgain;

  return underLock(deps, principal.customer, async (tx) => {
    const order = await tx.find(principal.customer, known.orderId);
    if (order === null) return failure("NOT_FOUND", "No such order.");
    if (!isOpen(order, request.proposalVersion)) return changed();
    const added = checked.value.lines
      .map((line) => line.offerId)
      .filter((offerId) => !order.offerIds.includes(offerId));
    if (await tx.hasUsedOffers(principal.customer, added))
      return failure("OFFER_INVALID", "An offer has already been used in an order.");
    // `known` and `order` are the same pending proposal: every change to a pending order raises
    // proposalVersion, and isOpen checked it under the lock.
    const revised = revision({
      principal,
      order,
      request,
      pairs,
      lines: checked.value.lines,
      alternatives,
      mandate: checked.value.mandate,
      evaluated,
      now,
    });
    const final =
      evaluated.evaluation.decision === "auto"
        ? await commitPlacement({
            tx,
            order: revised,
            creditLimit: principal.creditLimit,
            payment: deps.payment,
            now,
          })
        : revised;
    await write(tx, final, request.proposalVersion);
    return ok(final);
  });
};

/**
 * A human decision on a pending order. Approve and remember answers NOT_IMPLEMENTED. The decision
 * is written only if the order is still pending at the request's proposalVersion, under the
 * customer's placement lock; otherwise everything written in that transaction rolls back.
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
  return underLock(deps, principal.customer, async (tx) => {
    const order = await tx.find(principal.customer, orderId);
    if (order === null) return failure("NOT_FOUND", "No such order.");
    if (!isOpen(order, request.proposalVersion)) return changed();
    const decided =
      request.decision === "approve"
        ? await approve(deps, principal, tx, order, mandate, now)
        : ok(reject(principal, order, request, now));
    if (!decided.ok) return decided;
    await write(tx, decided.value, request.proposalVersion);
    return decided;
  });
};
