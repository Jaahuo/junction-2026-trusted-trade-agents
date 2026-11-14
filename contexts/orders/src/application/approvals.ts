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
import { appendOrderAudit, commitPlacement } from "./commit-placement.ts";
import { auditOf, checkTokens, type Evaluated, evaluateChecked, type OrderDeps } from "./orders.ts";
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

/**
 * Thrown inside the placement transaction when the guarded write finds the order changed, so the
 * rows written before it (history, audit) roll back. A payment authorization already made at the
 * payment provider is not undone by the rollback.
 */
class ChangedMeanwhile extends Error {
  constructor(readonly orderId: string) {
    super("The order changed under the customer's lock.");
  }
}

/** Runs `work` under the customer's lock; a ChangedMeanwhile rolls it back and answers 409. */
const underLock = async (
  deps: OrderDeps,
  customer: string,
  work: (tx: OrderTx) => Promise<Result<StoredOrder, DecisionError>>,
): Promise<Result<StoredOrder, DecisionError>> => {
  try {
    return await deps.store.withCustomerLock(customer, work);
  } catch (error) {
    if (!(error instanceof ChangedMeanwhile)) throw error;
    // Every writer of a pending order holds this lock, so another writer changed it without it.
    console.error("A pending order changed under the customer's lock.", {
      orderId: error.orderId,
    });
    return changed();
  }
};

/** The guarded write or a rollback: when the order is no longer pending at `proposalVersion`. */
const guardedWrite = async (tx: OrderTx, order: StoredOrder, proposalVersion: number) => {
  if (!(await tx.decide(order, proposalVersion))) throw new ChangedMeanwhile(order.orderId);
};

/** A fault on the offers side, logged with the order it hit. */
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
  if (isExpired(order.lines, now))
    return failure("OFFER_EXPIRED", "An offer of this order has expired.");
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

type Revision = Extract<DecideApprovalRequest, { decision: "edit" | "pick_alternative" }>;
type Changes = Extract<Revision, { decision: "edit" }>["changes"];
/**
 * One line of a proposed revision and its token: `previous` is the line it takes the place of, the
 * line itself when it is kept, or null when it is added.
 */
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
 * A refusal that comes from the approver's change: the product cannot be offered at that amount or
 * against a hard constraint. Every other omit reason (no stock, sales blocked, no price or delivery
 * date, a product the catalog dropped) means the line cannot be supplied as it stands now. Offers
 * answers 502 itself when it has no live price source, so NO_PRICE here is about the product.
 */
const REFUSES_CHANGE: ReadonlySet<OmitReason> = new Set([
  "INVALID_QUANTITY",
  "CONSTRAINT_CONTRADICTED",
]);

/**
 * The answer for a line the re-quote did not offer again: 400 when the approver's change on that
 * product is what offers refused, otherwise 409 with the reason, so the approver changes or rejects.
 * A line offers neither offered nor omitted is a fault on the offers side.
 */
const notOffered = (
  order: StoredOrder,
  line: OrderLine,
  omitted: OffersResult["omitted"],
  changes: Changes,
): Result<never, DecisionError> => {
  const { productId, product, replaces } = line.claims;
  const entry = omitted.find((candidate) => candidate.productId === productId);
  if (entry === undefined)
    return upstream(order.orderId, "The re-quote neither offered nor omitted a line.", {
      productId,
    });
  if (REFUSES_CHANGE.has(entry.reason) && changes.some((change) => change.productId === productId))
    return failure(
      "BAD_REQUEST",
      `${product.name} cannot be offered with that change: ${entry.detail}.`,
    );
  // A substitute cannot be edited into stock; the approver's way out is a new set of offers.
  const advice =
    replaces === null
      ? "Change it or reject the order."
      : "Reject the order and ask the agent for new offers.";
  return failure("CONFLICT", `${product.name} cannot be offered again: ${entry.detail}. ${advice}`);
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
    const notApplied = unapplied(line, offer.claims, changes);
    if (notApplied !== null)
      return upstream(order.orderId, `The re-quote did not apply ${notApplied}.`, {
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
 * What the re-quote of `line` failed to apply, or null: its amount (the changed one, or the line's
 * own when unchanged; a shortfall may lower it) and its requested date.
 */
const unapplied = (line: OrderLine, fresh: OfferClaims, changes: Changes): string | null => {
  const change = changes.find((entry) => entry.productId === line.claims.productId);
  const asked = change?.quantity ?? line.claims.quantity;
  if (fresh.quantity.unit !== asked.unit) return "the unit of the amount";
  if (fresh.shortfall === null && fresh.quantity.value !== asked.value) return "the amount";
  const date = change?.deliverBy ?? line.claims.requestedDate;
  return fresh.requestedDate === date ? null : "the requested date";
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

/** Net price of one sales unit, deposits included, at full precision. */
const unitCost = (claims: OfferClaims): number =>
  claims.unitPrice.net + claims.deposits / claims.quantity.value;

const samePack = (previous: OfferClaims, current: OfferClaims): boolean => {
  const before = previous.product.perSalesUnit;
  const after = current.product.perSalesUnit;
  return before === null || after === null
    ? before === after
    : before.value === after.value && before.unit === after.unit;
};

/**
 * The products whose re-quoted price is above the one the approver saw: a higher net unit price
 * with deposits, or a different pack size, which changes what one unit buys.
 */
const pricedUp = (pairs: Pair[]): string[] =>
  pairs.flatMap(({ previous, current }) =>
    previous !== null &&
    (unitCost(current.claims) > unitCost(previous.claims) ||
      !samePack(previous.claims, current.claims))
      ? [current.claims.productId]
      : [],
  );

/**
 * A higher price than the approver saw adds PRICE_CHANGED, as SPEC-011 does for a re-quote at
 * approval, so the order waits for them instead of being placed at a price nobody approved.
 */
const withPriceChanged = ({ evaluation, byProduct }: Evaluated, products: string[]): Evaluated => {
  if (products.length === 0) return { evaluation, byProduct };
  const reasons: ReasonCode[] = evaluation.reasons.includes("PRICE_CHANGED")
    ? evaluation.reasons
    : [...evaluation.reasons, "PRICE_CHANGED"];
  const marked = new Map(byProduct);
  for (const productId of products) {
    const current = marked.get(productId) ?? [];
    if (!current.includes("PRICE_CHANGED")) marked.set(productId, [...current, "PRICE_CHANGED"]);
  }
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
    previous.unitPrice.net === current.unitPrice.net
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
  alternatives: Kept;
  mandate: Mandate | null;
  evaluated: Evaluated;
  now: Date;
}): { order: StoredOrder; events: AuditEvent[] } => {
  const { principal, order, request, pairs, lines, mandate, evaluated, now } = input;
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
  const { kept, dropped } = input.alternatives;
  const drops: AuditEvent[] =
    dropped === 0
      ? []
      : [
          {
            at,
            actor: "server",
            event: "edited",
            detail: `${dropped} alternative${dropped === 1 ? "" : "s"} dropped: expired or made under another mandate`,
          },
        ];
  const checks = auditOf(evaluation, byProduct, at).filter(
    (event) => event.event !== "order_requested",
  );
  const claims = lines.map((line) => line.claims);
  const revised: StoredOrder = {
    ...order,
    offerIds: lines.map((line) => line.offerId),
    lines,
    alternatives: kept,
    mandateId: mandate?.mandateId ?? null,
    mandateVersion: mandate?.version ?? null,
    // `auto` is stored as pending here; revise then sends it through commitPlacement, which places
    // it or rejects it on credit or payment.
    status: evaluation.decision === "rejected" ? "rejected" : "pending_approval",
    reasons: evaluation.reasons,
    proposalVersion: order.proposalVersion + 1,
    total: { net: netTotal(claims), gross: grossTotal(claims) },
    decision:
      evaluation.decision === "needs_approval"
        ? null
        : { action: request.decision, next: null, note: null, by: principal.accountId, at },
    requotes: [...order.requotes, ...requotes],
  };
  // The events are appended to the hash-chained audit by the caller (appendOrderAudit).
  return { order: revised, events: [...edits, ...drops, ...checks] };
};

interface Kept {
  kept: OrderLine[];
  dropped: number;
}

/** Alternatives that expired or were made under another mandate cannot be picked, so they go. */
const pickable = (alternatives: OrderLine[], mandate: Mandate | null, now: Date): Kept => {
  const kept = alternatives.filter(
    (line) =>
      !isExpired([line], now) &&
      (mandate === null ||
        (line.claims.mandateId === mandate.mandateId &&
          line.claims.mandateVersion === mandate.version)),
  );
  return { kept, dropped: alternatives.length - kept.length };
};

/** The account's payment terms changed since the offers were made, so none of them can be placed. */
const termsChanged = (principal: Principal, lines: OrderLine[]): boolean =>
  lines.some((line) => line.claims.paymentTerms !== principal.paymentTerms);

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
  const alternative = isEdit
    ? []
    : known.alternatives.filter((line) => line.offerId === request.offerId);
  if (termsChanged(principal, [...known.lines, ...alternative]))
    return failure(
      "CONFLICT",
      "The account's payment terms changed since the offers were made. Reject the order and ask the agent for new offers.",
    );
  const proposal = isEdit
    ? await edited(deps.offers, known, request.changes)
    : picked(known, request.offerId);
  if (!proposal.ok) return proposal;
  const tokens = proposal.value.map((line) => line.token);
  const now = deps.now();
  // The stored alternatives were checked when the order was placed; they are not checked again here.
  const checked = await checkTokens(deps, principal, tokens, [], now);
  if (!checked.ok)
    return isEdit && checked.error.code === "OFFER_INVALID"
      ? upstream(known.orderId, "A re-quoted offer failed verification.", {
          message: checked.error.message,
        })
      : failure(checked.error.code, checked.error.message);
  if (isExpired(checked.value.lines, now))
    return failure("OFFER_EXPIRED", "An offer of this order has expired.");
  const alternatives = pickable(
    known.alternatives.filter((line) => !tokens.includes(line.token)),
    checked.value.mandate,
    now,
  );
  if (alternatives.dropped > 0)
    console.log("Alternatives that can no longer be picked were dropped.", {
      orderId: known.orderId,
      dropped: alternatives.dropped,
    });
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
    // `known` and `order` are the same pending proposal: every write that keeps an order pending
    // raises proposalVersion, every other write moves it out of pending, and isOpen checked it here.
    const proposed = revision({
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
    // Verifies the stored chain, then appends the revision's events to it.
    const revised = await appendOrderAudit(proposed.order, proposed.events);
    if (!revised.ok) return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    let final = revised.value;
    if (evaluated.evaluation.decision === "auto") {
      const placed = await commitPlacement({
        tx,
        order: revised.value,
        creditLimit: principal.creditLimit,
        payment: deps.payment,
        signReceipt: deps.signReceipt,
        now,
      });
      if (!placed.ok) return failure("UPSTREAM_FAILED", "The order could not be finalized.");
      final = placed.value;
    }
    await guardedWrite(tx, final, request.proposalVersion);
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
    const verified = await appendOrderAudit(order, []);
    if (!verified.ok) return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    const decided =
      request.decision === "approve"
        ? await approve(deps, principal, tx, order, mandate, now)
        : await reject(principal, order, request, now);
    if (!decided.ok) return decided;
    await guardedWrite(tx, decided.value, request.proposalVersion);
    return decided;
  });
};
