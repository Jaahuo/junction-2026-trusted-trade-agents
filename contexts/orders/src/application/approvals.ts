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
import { grossTotal, netTotal, ruleFor } from "../domain/evaluate.ts";
import { appendOrderAudit, commitPlacement } from "./commit-placement.ts";
import { expireCutoff } from "./cutoff.ts";
import {
  auditOf,
  type Checked,
  checkTokens,
  type Evaluated,
  evaluateChecked,
  type OrderDeps,
} from "./orders.ts";
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

/**
 * Thrown inside the placement transaction when commitPlacement fails, so everything written before
 * it in that transaction rolls back. A payment authorization already made is not undone.
 */
class NotFinalized extends Error {
  constructor(readonly orderId: string) {
    super("The order could not be finalized.");
  }
}

/**
 * Runs `work` under the customer's lock. A ChangedMeanwhile rolls it back and answers 409; a
 * NotFinalized rolls it back and answers 502. Both are logged with the order they hit.
 */
const underLock = async (
  deps: OrderDeps,
  customer: string,
  work: (tx: OrderTx) => Promise<Result<StoredOrder, DecisionError>>,
): Promise<Result<StoredOrder, DecisionError>> => {
  try {
    return await deps.store.withCustomerLock(customer, work);
  } catch (error) {
    if (error instanceof NotFinalized) {
      console.error("The order could not be finalized; the placement rolled back.", {
        orderId: error.orderId,
      });
      return failure("UPSTREAM_FAILED", "The order could not be finalized. Try again.");
    }
    if (!(error instanceof ChangedMeanwhile)) throw error;
    // Every writer of a pending order holds this lock, so another writer changed it without it.
    console.error("A pending order changed under the customer's lock.", {
      orderId: error.orderId,
    });
    return changed();
  }
};

/** Places `order` through commitPlacement, or rolls the transaction back (NotFinalized). */
const placeOrThrow = async (
  deps: OrderDeps,
  principal: Principal,
  tx: OrderTx,
  order: StoredOrder,
  now: Date,
): Promise<StoredOrder> => {
  const placed = await commitPlacement({
    tx,
    order,
    creditLimit: principal.creditLimit,
    payment: deps.payment,
    signReceipt: deps.signReceipt,
    now,
  });
  if (!placed.ok) throw new NotFinalized(order.orderId);
  return placed.value;
};

/** The guarded write or a rollback: when the order is no longer pending at `proposalVersion`. */
const guardedWrite = async (tx: OrderTx, order: StoredOrder, proposalVersion: number) => {
  if (!(await tx.decide(order, proposalVersion))) throw new ChangedMeanwhile(order.orderId);
};

/** A fault on the offers side, logged with the order it hit; the order is left as it was. */
const upstream = (orderId: string, message: string, detail: object = {}) => {
  console.error(message, { orderId, ...detail });
  return failure(
    "UPSTREAM_FAILED",
    "The offers could not be re-quoted. Try again; if it keeps failing, reject the order and ask the agent for new offers.",
  );
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

/** An offer that expired or whose order cut-off passed can no longer be placed. */
const lapsed = (lines: OrderLine[], now: Date): boolean =>
  isExpired(lines, now) ||
  lines.some((line) => line.claims.cutoffAt !== null && new Date(line.claims.cutoffAt) <= now);

const madeUnderOtherMandate = (order: StoredOrder, mandate: Mandate): boolean =>
  order.lines.some(
    (line) =>
      line.claims.mandateId !== mandate.mandateId || line.claims.mandateVersion !== mandate.version,
  );

/**
 * Approve: re-checks the order against the mandate read before the lock and the offers' expiry at
 * `now` (read under the lock), then places it through commitPlacement, which runs the credit and
 * payment steps (SPEC-010, SPEC-011). An order whose offers were already stale when the decision
 * arrived went through approveWithRequote instead. An offer that expires while the decision waits
 * for the lock answers 409 OFFER_EXPIRED and the approver approves again, which re-quotes it. The
 * mandate is not read again under the lock: a mandate change in that window is not seen.
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
          rule: "Current mandate",
          detail: `${REASON_TEXT.MANDATE_INVALID} No current mandate is available; previous mandate ${order.mandateId ?? "unknown"}, version ${order.mandateVersion ?? "unknown"}.`,
        },
        { at, actor: "server", event: "rejected", reason: "MANDATE_INVALID" },
      ],
    );
    return rejected.ok
      ? ok(rejected.value)
      : failure("UPSTREAM_FAILED", "The audit record could not be verified.");
  }
  if (madeUnderOtherMandate(order, mandate))
    return failure(
      "STALE_OFFER",
      "The mandate changed since the offers were made. Approve again to re-quote.",
    );
  if (isExpired(order.lines, now))
    return failure(
      "OFFER_EXPIRED",
      "An offer of this order has expired. Approve again to re-quote.",
    );
  return ok(await placeOrThrow(deps, principal, tx, decided, now));
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
  const approved = await tx.approvedWithPair(order.customer, pair);
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

/** Every offer ID the order has held: its lines and both sides of its requotes (SPEC-009). */
const usedOfferIds = (order: StoredOrder): Set<string> =>
  new Set([
    ...order.offerIds,
    ...order.requotes.flatMap((entry) => [entry.previous.offerId, entry.current.offerId]),
  ]);

/**
 * Re-quote every line through `requote`, with the approver's changes when there are any (an edit)
 * or none (an approval whose offers went stale), so no line keeps an old price, date or mandate.
 * Each fresh offer is matched to its line by product and by the product it replaces, using the
 * response's copy of the claims; `signedMismatch` then checks the signed tokens themselves. An
 * answer that does not fit the request is a fault of the offers side.
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
  const used = usedOfferIds(order);
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

/**
 * What the signed claims of a re-quoted line contradict, or null. Lines are matched on the
 * response's copy of the claims; what is stored and placed is the token, so the token must name the
 * same product and replaced product as the line, carry the asked amount and date, have an offer ID
 * the order never used, and agree with the offer ID the line carries.
 */
const signedMismatch = (
  order: StoredOrder,
  pairs: Pair[],
  lines: OrderLine[],
  changes: Changes,
): string | null => {
  // Every line is re-quoted, so a checked line without a pair kept an offer the order already holds.
  if (pairs.length !== lines.length) return "an offer the order already holds";
  const used = usedOfferIds(order);
  for (const { previous, current } of pairs) {
    if (previous === null) return "a line no line asked for";
    const before = previous.claims;
    const after = current.claims;
    if (after.productId !== before.productId || after.replaces !== before.replaces)
      return "another product than the line";
    if (current.offerId !== after.offerId) return "an offer ID its token does not carry";
    if (used.has(after.offerId)) return "an offer this order already used";
    const notApplied = unapplied(previous, after, changes);
    if (notApplied !== null) return `a token without ${notApplied}`;
  }
  return null;
};

/** Net price of one sales unit, deposits included, at full precision. */
const unitCost = (claims: OfferClaims): number =>
  claims.unitPrice.net + claims.deposits / claims.quantity.value;

/** Gross line total per sales unit (deposits included when the offer includes them). */
const unitGross = (claims: OfferClaims): number => claims.total.gross / claims.quantity.value;

const samePack = (previous: OfferClaims, current: OfferClaims): boolean => {
  const before = previous.product.perSalesUnit;
  const after = current.product.perSalesUnit;
  return before === null || after === null
    ? before === after
    : before.value === after.value && before.unit === after.unit;
};

/**
 * The one verdict on a re-quote: the lines where the new offer is worse than the line the approver
 * saw. `price`: a higher net unit price with deposits, a higher gross unit price, another pack size
 * (it changes what one unit buys), or deposits that became unknown (an unknown amount is never
 * cheaper). `availability`: a later delivery date, another amount or unit, or a new shortfall. An
 * edit changes amounts on purpose, so it uses `price` only; an approval uses both.
 */
const worsened = (pairs: Pair[]): { price: Pair[]; availability: Pair[] } => {
  const price: Pair[] = [];
  const availability: Pair[] = [];
  for (const pair of pairs) {
    if (pair.previous === null) continue;
    const before = pair.previous.claims;
    const after = pair.current.claims;
    if (
      unitCost(after) > unitCost(before) ||
      unitGross(after) > unitGross(before) ||
      !samePack(before, after) ||
      (before.depositsIncluded !== false && after.depositsIncluded === false)
    )
      price.push(pair);
    if (
      after.deliveryDate > before.deliveryDate ||
      after.quantity.value !== before.quantity.value ||
      after.quantity.unit !== before.quantity.unit ||
      (after.shortfall !== null && before.shortfall === null)
    )
      availability.push(pair);
  }
  return { price, availability };
};

/** "productId|reason" for a reason about one product, "|reason" for a reason about the order. */
const keyOf = (reason: ReasonCode, productId: string | undefined): string =>
  `${productId ?? ""}|${reason}`;

/**
 * Each reason of an evaluation as product and reason pairs: one per evidence entry, the same split
 * auditOf writes as check_failed events. A reason without evidence counts for the whole order.
 */
const reasonKeys = ({ evaluation, evidence }: Evaluated): Set<string> => {
  const keys = new Set(evidence.map((entry) => keyOf(entry.reason, entry.productId)));
  for (const reason of evaluation.reasons)
    if (!evidence.some((entry) => entry.reason === reason)) keys.add(keyOf(reason, undefined));
  return keys;
};

/**
 * The product and reason pairs the approver was shown: the check_failed events of the current
 * proposal, which end with its last sent_to_approval. None found means none can be taken as seen.
 */
const shownReasonKeys = (order: StoredOrder): Set<string> => {
  const keys = new Set<string>();
  const end = order.audit.findLastIndex((event) => event.event === "sent_to_approval");
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = order.audit[index];
    if (event === undefined) break;
    if (event.event === "check_failed" && event.reason !== undefined)
      keys.add(keyOf(event.reason, event.productId));
    else if (event.event !== "check_passed" && event.event !== "offer_verified") break;
  }
  return keys;
};

const priceTerms = (claims: OfferClaims): string =>
  `net ${claims.unitPrice.net} EUR, incl. VAT ${cents(unitGross(claims))} EUR, deposits ${depositsOf(claims)}, deposit per sales unit ${claims.deposits / claims.quantity.value} EUR, net plus deposit ${unitCost(claims)} EUR, pack ${packOf(claims)}`;

/** The price terms of one line before and after, for a PRICE_CHANGED check_failed event. */
const priceDetail = (before: OfferClaims, after: OfferClaims): string =>
  `Previous ${priceTerms(before)}; current ${priceTerms(after)}. Policy: approval required for a higher net or gross cost, a changed pack or unknown deposits.`;

const REQUOTE_RULE: Partial<Record<ReasonCode, string>> = {
  PRICE_CHANGED: "Requoted unit cost and pack",
  AVAILABILITY_DIFFERS: "Requoted delivery and amount",
};

/**
 * Adds `reason`, with evidence per line, for the lines a re-quote or edit made worse (see
 * `worsened`), so the order waits for the approver instead of being placed on terms nobody approved.
 */
const withReason = (
  { evaluation, evidence }: Evaluated,
  reason: ReasonCode,
  pairs: Pair[],
): Evaluated => {
  if (pairs.length === 0) return { evaluation, evidence };
  const reasons: ReasonCode[] = evaluation.reasons.includes(reason)
    ? evaluation.reasons
    : [...evaluation.reasons, reason];
  const added: Evaluated["evidence"] = pairs.flatMap(({ previous, current }) => {
    const productId = current.claims.productId;
    if (
      previous === null ||
      evidence.some((entry) => entry.reason === reason && entry.productId === productId)
    )
      return [];
    return [
      {
        reason,
        rule: REQUOTE_RULE[reason] ?? "Requoted terms",
        productId,
        detail:
          reason === "PRICE_CHANGED"
            ? priceDetail(previous.claims, current.claims)
            : `${change(previous.claims, current.claims)}. Policy: approval required for a later delivery, another amount or a new shortfall.`,
      },
    ];
  });
  return {
    evaluation: {
      decision: evaluation.decision === "rejected" ? "rejected" : "needs_approval",
      reasons,
    },
    evidence: [...evidence, ...added],
  };
};

const cents = (value: number): number => Math.round(value * 100) / 100;

/** ", label before → after", or nothing when the value did not change. */
const differs = (label: string, before: string, after: string, unit = ""): string =>
  before === after ? "" : `, ${label} ${before} → ${after}${unit}`;

const packOf = ({ product }: OfferClaims): string =>
  product.perSalesUnit === null
    ? "unknown"
    : `${product.perSalesUnit.value} ${product.perSalesUnit.unit}`;

const depositsOf = (claims: OfferClaims): string =>
  claims.depositsIncluded === false ? "unknown" : `${claims.deposits} EUR`;

/**
 * The audit text of one changed line: amount, delivery date, net and gross unit price, deposits and
 * pack, so the approver can see which term a re-quote or edit changed.
 */
const change = (previous: OfferClaims, current: OfferClaims): string => {
  const name =
    previous.productId === current.productId
      ? current.product.name
      : `${previous.product.name} → ${current.product.name}`;
  const amount =
    previous.quantity.value === current.quantity.value &&
    previous.quantity.unit === current.quantity.unit
      ? `${current.quantity.value} ${current.quantity.unit}`
      : previous.quantity.unit === current.quantity.unit
        ? `${previous.quantity.value} → ${current.quantity.value} ${current.quantity.unit}`
        : `${previous.quantity.value} ${previous.quantity.unit} → ${current.quantity.value} ${current.quantity.unit}`;
  return [
    `${name}: ${amount}`,
    differs("delivery", previous.deliveryDate, current.deliveryDate),
    differs("unit price", `${previous.unitPrice.net}`, `${current.unitPrice.net}`, " EUR net"),
    differs(
      "unit price incl. VAT",
      `${cents(unitGross(previous))}`,
      `${cents(unitGross(current))}`,
      " EUR",
    ),
    differs("deposits", depositsOf(previous), depositsOf(current)),
    differs("pack", packOf(previous), packOf(current)),
  ].join("");
};

/** Who changed the lines: the approver's edit or pick, or the server's re-quote at approval. */
type ChangedBy = "approver" | "requote";

/**
 * The revised proposal: the new lines, every reason of the new check, `proposalVersion` + 1, one
 * `Requote` per replaced line (it keeps the replaced offer ID consumed, SPEC-009) and an `edited`
 * event per change by the approver, or a `requoted` event per line re-quoted by the server, then
 * the check events.
 */
const revision = (input: {
  principal: Principal;
  order: StoredOrder;
  action: Revision["decision"] | "approve";
  changedBy: ChangedBy;
  pairs: Pair[];
  lines: OrderLine[];
  alternatives: Kept;
  mandate: Mandate | null;
  evaluated: Evaluated;
  now: Date;
}): { order: StoredOrder; events: AuditEvent[] } => {
  const { principal, order, action, changedBy, pairs, lines, mandate, evaluated, now } = input;
  const { evaluation, evidence } = evaluated;
  const at = now.toISOString();
  const requotes: Requote[] = pairs.flatMap(({ previous, current }) =>
    previous === null
      ? []
      : [{ at, previous: previous.claims, current: current.claims, reasons: evaluation.reasons }],
  );
  const edits = pairs.map(({ previous, current }): AuditEvent => {
    const detail =
      previous === null
        ? `${current.claims.product.name}: added`
        : change(previous.claims, current.claims);
    return changedBy === "approver"
      ? approverEvent(at, "edited", { detail })
      : { at, actor: "server", event: "requoted", detail };
  });
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
  const checks = auditOf(evaluation, evidence, { lines, mandate }, at).filter(
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
    // An order to be placed is stored as pending here; its caller (revise for `auto`,
    // approveWithRequote when the terms are the same or better) then sends it through
    // commitPlacement, which places it or rejects it on credit or payment.
    status: evaluation.decision === "rejected" ? "rejected" : "pending_approval",
    reasons: evaluation.reasons,
    proposalVersion: order.proposalVersion + 1,
    total: { net: netTotal(claims), gross: grossTotal(claims) },
    // A pending proposal has no decision yet. A rejection by the re-check after a re-quote is the
    // server's, not the approver's approval, so it records none either.
    decision:
      evaluation.decision === "needs_approval" ||
      (changedBy === "requote" && evaluation.decision === "rejected")
        ? null
        : { action, next: null, note: null, by: principal.accountId, at },
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
 * The token checks of freshly re-quoted lines. The tokens are minted by the offers side, so any
 * refusal (another mandate, customer or payment terms, a bad signature) is a fault there: logged
 * and answered 502 with the order left as it was.
 */
const checkRequoted = async (
  deps: ApprovalDeps,
  principal: Principal,
  order: StoredOrder,
  proposal: Proposed[],
  changes: Changes,
  now: Date,
): Promise<Result<{ checked: Checked; pairs: Pair[] }, DecisionError>> => {
  const tokens = proposal.map((line) => line.token);
  const checked = await checkTokens(deps, principal, tokens, [], now);
  if (!checked.ok)
    return checked.error.code === "UPSTREAM_FAILED"
      ? failure("UPSTREAM_FAILED", checked.error.message)
      : upstream(order.orderId, "A re-quoted offer failed the token checks.", {
          code: checked.error.code,
          message: checked.error.message,
        });
  if (isExpired(checked.value.lines, now))
    return upstream(order.orderId, "The re-quote returned an offer that has already expired.");
  const pairs = pairsOf(proposal, checked.value.lines);
  const mismatch = signedMismatch(order, pairs, checked.value.lines, changes);
  if (mismatch !== null) return upstream(order.orderId, `A re-quoted token carries ${mismatch}.`);
  return ok({ checked: checked.value, pairs });
};

/**
 * Edit and pick_alternative (SPEC-011): the new lines go through every token check and the rules of
 * SPEC-009 again. A picked alternative that expired is refused with 409 OFFER_EXPIRED and the order
 * is unchanged. A reason keeps the order pending as the next proposal, a rejecting reason rejects
 * it, and none sends it through commitPlacement. An edited line priced higher than before (see
 * `worsened`) adds PRICE_CHANGED. An edit can never skip a check.
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
  let checked: Checked;
  let pairs: Pair[];
  if (isEdit) {
    const requoted = await checkRequoted(
      deps,
      principal,
      known,
      proposal.value,
      request.changes,
      now,
    );
    if (!requoted.ok) return requoted;
    ({ checked, pairs } = requoted.value);
  } else {
    // The stored alternatives were checked when the order was placed; they are not checked again.
    const result = await checkTokens(deps, principal, tokens, [], now);
    if (!result.ok) return failure(result.error.code, result.error.message);
    if (isExpired(result.value.lines, now))
      return failure("OFFER_EXPIRED", "An offer of this order has expired.");
    checked = result.value;
    pairs = pairsOf(proposal.value, checked.lines);
  }
  const alternatives = pickable(
    known.alternatives.filter((line) => !tokens.includes(line.token)),
    checked.mandate,
    now,
  );
  if (alternatives.dropped > 0)
    console.log("Alternatives that can no longer be picked were dropped.", {
      orderId: known.orderId,
      dropped: alternatives.dropped,
    });
  const checkedAgain = await evaluateChecked(deps, principal, checked, now);
  const evaluated = isEdit
    ? withReason(checkedAgain, "PRICE_CHANGED", worsened(pairs).price)
    : checkedAgain;

  return underLock(deps, principal.customer, async (tx) => {
    const order = await tx.find(principal.customer, known.orderId);
    if (order === null) return failure("NOT_FOUND", "No such order.");
    if (!isOpen(order, request.proposalVersion)) return changed();
    const lockNow = deps.now();
    const cutoff = await expireCutoff(tx, order, lockNow);
    if (cutoff === "audit_invalid")
      return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    if (cutoff === "expired") return changed();
    // The new lines were checked before the lock; one that lapsed while this waited is not placed.
    if (lapsed(checked.lines, lockNow) && !lapsed(checked.lines, now))
      return failure(
        "OFFER_EXPIRED",
        "An offer expired while the order was being changed. Try again.",
      );
    const added = checked.lines
      .map((line) => line.offerId)
      .filter((offerId) => !order.offerIds.includes(offerId));
    if (await tx.hasUsedOffers(principal.customer, added))
      return isEdit
        ? upstream(order.orderId, "The re-quote returned an offer already used in an order.")
        : failure("OFFER_INVALID", "An offer has already been used in an order.");
    // `known` and `order` are the same pending proposal: every write that keeps an order pending
    // raises proposalVersion, every other write moves it out of pending, and isOpen checked it here.
    const proposed = revision({
      principal,
      order,
      action: request.decision,
      changedBy: "approver",
      pairs,
      lines: checked.lines,
      alternatives,
      mandate: checked.mandate,
      evaluated,
      now: lockNow,
    });
    // Verifies the stored chain, then appends the revision's events to it.
    const revised = await appendOrderAudit(proposed.order, proposed.events);
    if (!revised.ok) return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    const final =
      evaluated.evaluation.decision === "auto"
        ? await placeOrThrow(deps, principal, tx, revised.value, lockNow)
        : revised.value;
    await guardedWrite(tx, final, request.proposalVersion);
    return ok(final);
  });
};

/** An approval whose offers expired or were made under another mandate needs a re-quote first. */
const needsRequote = (order: StoredOrder, mandate: Mandate, now: Date): boolean =>
  madeUnderOtherMandate(order, mandate) || isExpired(order.lines, now);

/**
 * Approve with re-quote (SPEC-011): every line gets a new offer under the current mandate through
 * `requote`, and the new lines run the token checks and the rules of SPEC-009 again (not the live
 * amount check: `validate` is not built). The new lines always replace the old ones (a `requoted`
 * event and a `Requote` per line, `proposalVersion` + 1). The order is then approved and placed only
 * when `worsened` finds nothing on any line and every product and reason pair of the new check was
 * on the proposal the approver saw. Otherwise it stays pending, with PRICE_CHANGED or
 * AVAILABILITY_DIFFERS on the lines that got worse (even when the old proposal already listed
 * them) or with the new reason, and the approver decides on the new terms. A rejecting reason from
 * the new check rejects it. A line offers no longer offers answers 409 or 400 and changes nothing.
 */
const approveWithRequote = async (
  deps: ApprovalDeps,
  principal: Principal,
  known: StoredOrder,
  request: Extract<DecideApprovalRequest, { decision: "approve" }>,
): Promise<Result<StoredOrder, DecisionError>> => {
  // A stale or decided proposal is refused before anything is asked of offers.
  if (!isOpen(known, request.proposalVersion)) return changed();
  if (termsChanged(principal, known.lines))
    return failure(
      "CONFLICT",
      "The account's payment terms changed since the offers were made. Reject the order and ask the agent for new offers.",
    );
  const proposal = await edited(deps.offers, known, []);
  if (!proposal.ok) return proposal;
  const now = deps.now();
  const requoted = await checkRequoted(deps, principal, known, proposal.value, [], now);
  if (!requoted.ok) return requoted;
  const { checked, pairs } = requoted.value;
  const alternatives = pickable(known.alternatives, checked.mandate, now);
  // Worse terms always come back to the approver, whatever reasons the old proposal already showed:
  // a higher price or a later date than they saw is never approved implicitly.
  const worse = worsened(pairs);
  const evaluated = withReason(
    withReason(await evaluateChecked(deps, principal, checked, now), "PRICE_CHANGED", worse.price),
    "AVAILABILITY_DIFFERS",
    worse.availability,
  );
  const shown = shownReasonKeys(known);
  const approvable =
    evaluated.evaluation.decision !== "rejected" &&
    worse.price.length === 0 &&
    worse.availability.length === 0 &&
    [...reasonKeys(evaluated)].every((key) => shown.has(key));

  return underLock(deps, principal.customer, async (tx) => {
    const order = await tx.find(principal.customer, known.orderId);
    if (order === null) return failure("NOT_FOUND", "No such order.");
    if (!isOpen(order, request.proposalVersion)) return changed();
    const lockNow = deps.now();
    const cutoff = await expireCutoff(tx, order, lockNow);
    if (cutoff === "audit_invalid")
      return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    if (cutoff === "expired") return changed();
    // The fresh offers were checked before the lock; one that lapsed while this waited is not placed.
    if (lapsed(checked.lines, lockNow) && !lapsed(checked.lines, now))
      return failure(
        "OFFER_EXPIRED",
        "A re-quoted offer expired while the order was being approved. Approve again.",
      );
    const added = checked.lines
      .map((line) => line.offerId)
      .filter((offerId) => !order.offerIds.includes(offerId));
    if (await tx.hasUsedOffers(principal.customer, added))
      return upstream(order.orderId, "The re-quote returned an offer already used in an order.");
    const proposed = revision({
      principal,
      order,
      action: "approve",
      changedBy: "requote",
      pairs,
      lines: checked.lines,
      alternatives,
      mandate: checked.mandate,
      evaluated,
      now: lockNow,
    });
    const revised = await appendOrderAudit(proposed.order, proposed.events);
    if (!revised.ok) return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    let final = revised.value;
    if (approvable) {
      const at = lockNow.toISOString();
      const approved = await appendOrderAudit(
        {
          ...revised.value,
          decision: { action: "approve", next: null, note: null, by: principal.accountId, at },
        },
        [approverEvent(at, "approved")],
      );
      if (!approved.ok)
        return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
      final = await placeOrThrow(deps, principal, tx, approved.value, lockNow);
    }
    await guardedWrite(tx, final, request.proposalVersion);
    return ok(final);
  });
};

/**
 * A human decision on a pending order. Approve and remember answers NOT_IMPLEMENTED. An approval
 * whose offers expired or were made under another mandate re-quotes first (approveWithRequote). The
 * decision is written only if the order is still pending at the request's proposalVersion, under
 * the customer's placement lock; otherwise everything written in that transaction rolls back.
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
    if (mandate !== null && needsRequote(known, mandate, deps.now()))
      return approveWithRequote(deps, principal, known, request);
  }

  return underLock(deps, principal.customer, async (tx) => {
    const order = await tx.find(principal.customer, orderId);
    if (order === null) return failure("NOT_FOUND", "No such order.");
    if (!isOpen(order, request.proposalVersion)) return changed();
    // The clock is read under the lock, so an offer that expired while this waited is caught.
    const now = deps.now();
    const cutoff = await expireCutoff(tx, order, now);
    if (cutoff === "audit_invalid")
      return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    if (cutoff === "expired") return changed();
    const verified = await appendOrderAudit(order, []);
    if (!verified.ok) return failure("UPSTREAM_FAILED", "The audit record could not be verified.");
    const decided =
      request.decision === "approve"
        ? await approve(deps, principal, tx, order, mandate, now)
        : await reject(principal, order, request, now);
    if (!decided.ok) return decided;
    await guardedWrite(tx, decided.value, request.proposalVersion);
    if (request.decision !== "approve" || !order.reasons.includes("SUBSTITUTION")) return decided;
    const offer = await standingOffer(tx, decided.value, mandate);
    return offer === undefined ? decided : ok({ ...decided.value, standingOffer: offer });
  });
};
