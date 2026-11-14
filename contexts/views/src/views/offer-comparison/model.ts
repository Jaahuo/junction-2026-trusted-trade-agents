import type { OfferClaims, OfferLine, OffersResult, StoredMandate } from "@app/contract";
import { formatDeliveryDate, formatQuantity, formatTimestamp } from "@app/ui/format";
import { intlLocale, lang, pick } from "../../shared/locale.ts";
import { CARD } from "../approval-card/card-strings.ts";
import {
  amount,
  day,
  money,
  number,
  stdUnits,
  timeOnly,
  unit,
  when,
} from "../approval-card/parts.ts";
import { OFFERS } from "./strings.ts";

// The offer comparison as data: one row per requested line, the agent's pick and the other
// options, the words the view shows, and the open/ask state. Free of the DOM, so the rules
// are tested without a browser.

/** auto (check icon): no approval needed for this product; attention (triangle): needs a
 * look; none (dash): not offered. */
export type Status = "auto" | "attention" | "none";

/** What an option offers: the agent's pick carries a "Pick" tag, another offer a "Use" link,
 * an offer that would be rejected nothing. */
type OptionAction = "pick" | "use" | null;

/** A price per litre or kilogram: "€8.40/kg" on screen, "€8.40 per kg" when read out. */
export type Price = { shown: string; spoken: string };

export type Option = {
  line: OfferLine;
  status: Exclude<Status, "none">;
  reason: string | null;
  price: Price | null;
  action: OptionAction;
  /** "+5 pts reliability · €0.10/L cheaper": how a substitute differs from the original. */
  differs: string | null;
};

export type OfferedRow = {
  kind: "offered";
  key: string;
  name: string;
  status: Exclude<Status, "none">;
  reason: string | null;
  price: Price | null;
  words: string;
  pick: OfferLine;
  options: Option[];
};

type OmittedRow = {
  kind: "omitted";
  key: string;
  name: string;
  status: "none";
  reason: string;
  words: string;
  detail: string;
};

export type Row = OfferedRow | OmittedRow;

type Rank = NonNullable<OfferLine["rank"]>;
const RANK = { best: 0, better: 1, good: 2 } as const satisfies Record<Rank, number>;
const byRank = (a: OfferLine, b: OfferLine) => RANK[a.rank ?? "good"] - RANK[b.rank ?? "good"];

/** "€8.40" in English, "8,40 €" in Finnish: always two decimals. */
const twoDecimals = (value: number) =>
  new Intl.NumberFormat(intlLocale(), {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
const cents = (value: number) => Math.round(value * 100) / 100;

/** The standard units a price per unit is given in, as the design writes them ("L", "kg"). */
const STD_UNIT = { LTR: "L", KGM: "kg", KG: "kg" } as const;
type StdUnit = keyof typeof STD_UNIT;
const isStd = (code: string): code is StdUnit => Object.hasOwn(STD_UNIT, code);
const perStd = (code: string) => (isStd(code) ? STD_UNIT[code] : unit(code));

/** Total net / (quantity × perSalesUnit): "€1.20/L". Null when the pack size is unknown, is
 * not in litres or kilograms, or the amount is not positive. */
export function pricePerStdUnit(claims: OfferClaims): Price | null {
  const pack = claims.product.perSalesUnit;
  const std = stdUnits(claims).value;
  if (pack === null || !isStd(pack.unit) || !(std > 0)) return null;
  const value = twoDecimals(claims.total.net / std);
  const spoken = pick(OFFERS).perSpoken[pack.unit];
  return { shown: `${value}/${STD_UNIT[pack.unit]}`, spoken: `${value} ${spoken}` };
}

/** Days the delivery comes after the requested date; 0 when on time, early or unreadable. */
function daysLate(claims: OfferClaims): number {
  const ms = Date.parse(claims.deliveryDate) - Date.parse(claims.requestedDate);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 86_400_000) : 0;
}

/** "64 of 80 l" for a partly available product, or null when the whole amount is offered. */
function partly(claims: OfferClaims): string | null {
  const short = claims.shortfall;
  if (short === null) return null;
  const offered = stdUnits(claims).value;
  return pick(OFFERS).partly(number(offered), number(offered + short.value), unit(short.unit));
}

const lateText = (days: number) => pick(OFFERS).late(days);

/** What AVAILABILITY_DIFFERS means for this offer in a few words: "64 of 80 l" or
 * "2 days late"; null when the offer is whole and on time. */
function availability(claims: OfferClaims): string | null {
  const part = partly(claims);
  if (part !== null) return part;
  const late = daysLate(claims);
  return late > 0 ? lateText(late) : null;
}

/** The short reason a row shows, or null when nothing needs a look. Never null when the
 * pre-check asks for approval or rejects, even without a reason code. AVAILABILITY_DIFFERS
 * reads as what differs ("64 of 80 l", "2 days late"). */
export function shortReason(line: OfferLine): string | null {
  const check = line.precheck;
  const text = pick(OFFERS);
  if (check === null) return text.notChecked;
  if (check.decision === "auto") return availability(line.claims);
  const first = check.reasons[0];
  if (first === "AVAILABILITY_DIFFERS") return availability(line.claims) ?? text.short[first];
  if (first !== undefined) return text.short[first];
  return check.decision === "rejected" ? text.wouldBeRejected : text.needsApproval;
}

/** auto only when nothing needs a look: shortReason is null only for an automatic pre-check
 * on a whole, on-time offer. */
function statusOf(line: OfferLine): Exclude<Status, "none"> {
  return shortReason(line) === null ? "auto" : "attention";
}

/** The status in words, for the row's accessible name. */
function statusWords(line: OfferLine): string {
  const check = line.precheck;
  const words = pick(OFFERS).words;
  if (check === null) return words.notChecked;
  if (check.decision === "rejected") return words.rejected;
  if (check.decision === "needs_approval") return words.needsApproval;
  return statusOf(line) === "auto" ? words.auto : words.attention;
}

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** How far one offer alone is over the gross order limit, as its own pre-check measured it;
 * null when the limit is unknown or the offer is within it. */
function ownOverage(line: OfferLine, limit: number | null): number | null {
  if (limit === null) return null;
  const over = cents(line.claims.total.gross - limit);
  return over > 0 ? over : null;
}

/** The offers the order would contain: the agent's picks, except those that would be
 * rejected. */
function orderedPicks(rows: Row[]): OfferLine[] {
  return rows.flatMap((row) =>
    row.kind === "offered" && row.pick.precheck?.decision !== "rejected" ? [row.pick] : [],
  );
}

/** How far the whole order (the picks that would be ordered) is over the mandate's gross
 * limit; null when the limit is unknown or the order is within it. */
function overLimit(rows: Row[], limit: number | null): number | null {
  if (limit === null) return null;
  const total = orderedPicks(rows).reduce((sum, line) => sum + line.claims.total.gross, 0);
  const over = cents(total - limit);
  return over > 0 ? over : null;
}

/** The sentences on what differs for AVAILABILITY_DIFFERS: "Only 64 of 80 l can be
 * delivered." and "Arrives Wed 25 Nov, 2 days late for the request." */
function availabilitySentences(claims: OfferClaims): string[] {
  const text = pick(OFFERS);
  const part = partly(claims);
  const late = daysLate(claims);
  return [
    ...(part === null ? [] : [text.onlyPart(part)]),
    ...(late > 0 ? [text.arrives(day(claims.deliveryDate), lateText(late))] : []),
  ];
}

/**
 * What would happen if the agent ordered this offer, as its own pre-check says: "Needs your
 * approval: €14.10 over your order limit." The amount is this offer's own, the way the
 * pre-check measured it; the order note gives the whole order's. AVAILABILITY_DIFFERS reads
 * as what differs.
 */
export function explain(line: OfferLine, limit: number | null = null): string {
  const check = line.precheck;
  const text = pick(OFFERS);
  const differs = availabilitySentences(line.claims);
  if (check === null) return [text.noAnswer, ...differs].join(" ");
  if (check.decision === "auto") return [text.autoSentence, ...differs].join(" ");
  const head = check.decision === "rejected" ? text.wouldBeRejected : text.needsYourApproval;
  const reasonText = pick(CARD).reason;
  const own = ownOverage(line, limit);
  const sentences = check.reasons.flatMap((reason) => {
    if (reason === "SPEND_OVER_LIMIT" && own !== null) return [text.overYourLimit(money(own))];
    if (reason === "AVAILABILITY_DIFFERS" && differs.length > 0) return differs;
    return [reasonText[reason]];
  });
  const [first, ...rest] = sentences;
  const covered = check.reasons.includes("AVAILABILITY_DIFFERS") ? [] : differs;
  return first === undefined
    ? [`${head}.`, ...covered].join(" ")
    : [`${head}: ${lowerFirst(first)}`, ...rest, ...covered].join(" ");
}

/** "+5 pts reliability · €0.10/L cheaper · other origin", or null without a comparison. A
 * difference that rounds to nothing is left out. */
function differsText(line: OfferLine): string | null {
  const c = line.comparison;
  if (c === null) return null;
  const pack = line.claims.product.perSalesUnit;
  const per = pack === null ? "" : `/${perStd(pack.unit)}`;
  const points = c.reliabilityDelta === null ? 0 : Math.round(c.reliabilityDelta * 100);
  const price = c.pricePerStdUnitDelta === null ? 0 : cents(c.pricePerStdUnitDelta);
  const text = pick(OFFERS);
  const parts = [
    points === 0 ? null : text.reliabilityDelta(points > 0 ? "+" : "−", Math.abs(points)),
    price === 0 ? null : text.priceDelta(`${twoDecimals(Math.abs(price))}${per}`, price > 0),
    c.originDiffers === true ? text.otherOrigin : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A substitute with no reason other than being a substitute (or none) shows its rank in
 * words instead of its short reason. */
function optionReason(line: OfferLine): string | null {
  const onlySubstitution =
    line.precheck !== null &&
    line.precheck.decision !== "rejected" &&
    line.precheck.reasons.every((r) => r === "SUBSTITUTION");
  return line.rank !== null && onlySubstitution && availability(line.claims) === null
    ? pick(OFFERS).rank[line.rank]
    : shortReason(line);
}

function optionOf(line: OfferLine, chosen: OfferLine): Option {
  return {
    line,
    status: statusOf(line),
    reason: optionReason(line),
    price: pricePerStdUnit(line.claims),
    action: line === chosen ? "pick" : line.precheck?.decision === "rejected" ? null : "use",
    differs: differsText(line),
  };
}

type Group = {
  key: string;
  productId: string;
  original: OfferLine | null;
  substitutes: OfferLine[];
};

/**
 * One group per requested line. get-offers lists every original first, in request order, and
 * then a ranked block of substitutes for each original with a shortfall, each block starting
 * again at its best. Only those short originals own a block. A short line whose block came
 * out empty cannot be told apart, so the next block then goes to it. Two lines of the same
 * product are two groups.
 */
function groupsOf(offers: OfferLine[]): Group[] {
  const groups: Group[] = [];
  const blocks = new Map<string, { at: number; last: number }>();
  for (const line of offers) {
    const replaces = line.claims.replaces;
    if (replaces === null) {
      groups.push({
        key: line.offerId,
        productId: line.claims.productId,
        original: line,
        substitutes: [],
      });
      continue;
    }
    const originals = groups.filter((g) => g.original !== null && g.productId === replaces);
    const short = originals.filter((g) => g.original?.claims.shortfall !== null);
    const owners = short.length > 0 ? short : originals;
    const rank = RANK[line.rank ?? "good"];
    const seen = blocks.get(replaces);
    // A rank that does not come after the previous one starts the next line's block.
    const at = seen === undefined ? 0 : rank <= seen.last ? seen.at + 1 : seen.at;
    blocks.set(replaces, { at, last: rank });
    const owner =
      owners[Math.min(at, owners.length - 1)] ??
      groups.find((g) => g.original === null && g.productId === replaces);
    if (owner === undefined)
      groups.push({
        key: `for:${replaces}`,
        productId: replaces,
        original: null,
        substitutes: [line],
      });
    else owner.substitutes.push(line);
  }
  return groups;
}

/** A line offered as itself, or (defensively) a line offered only through substitutes, whose
 * row then carries why the product itself was left out. */
function offeredRow(group: Group, leftOut: string | null): OfferedRow | null {
  const ranked = group.substitutes.toSorted(byRank);
  const chosen = group.original ?? ranked[0];
  if (chosen === undefined) return null;
  const others = group.original === null ? ranked.slice(1) : ranked;
  const options = [chosen, ...others].map((line) => optionOf(line, chosen));
  const text = pick(OFFERS);
  if (group.original === null)
    return {
      kind: "offered",
      key: group.key,
      name: text.productId(group.productId),
      status: "attention",
      reason: leftOut ?? text.substitute,
      price: pricePerStdUnit(chosen.claims),
      words: text.words.onlySubstitute,
      pick: chosen,
      options,
    };
  return {
    kind: "offered",
    key: group.key,
    name: chosen.claims.product.name,
    status: statusOf(chosen),
    reason: shortReason(chosen),
    price: pricePerStdUnit(chosen.claims),
    words: statusWords(chosen),
    pick: chosen,
    options,
  };
}

/** One row per requested line: offered lines first, then the ones left out. Every omitted
 * entry is kept: it is its own row, or the reason on the row of its substitutes. */
export function rowsOf(result: OffersResult): Row[] {
  const omitted = result.omitted.map((entry, index) => ({ entry, index, used: false }));
  const offered = groupsOf(result.offers).flatMap((group) => {
    let leftOut: string | null = null;
    if (group.original === null) {
      const match = omitted.find((o) => !o.used && o.entry.productId === group.productId);
      if (match !== undefined) {
        match.used = true;
        leftOut = pick(OFFERS).omitted[match.entry.reason];
      }
    }
    return offeredRow(group, leftOut) ?? [];
  });
  const text = pick(OFFERS);
  const rest = omitted
    .filter((o) => !o.used)
    .map(({ entry, index }): OmittedRow => ({
      kind: "omitted",
      key: `omitted:${index}`,
      name: text.productId(entry.productId),
      status: "none",
      reason: text.omitted[entry.reason],
      words: text.words.notOffered,
      detail: entry.detail,
    }));
  return [...offered, ...rest];
}

/** "Test butter 500 g, needs approval, over limit, €8.40 per kg". */
export function accessibleName(row: Row): string {
  const reason = row.reason === null ? [] : [row.reason.toLowerCase()];
  const price =
    row.kind === "omitted"
      ? []
      : [row.price === null ? pick(OFFERS).priceUnknown : row.price.spoken];
  return [row.name, row.words, ...reason, ...price].join(", ");
}

/** "3 products · Thu 20 Nov" and "until 21:40" (or "until 19 Nov, 21:40" on another day);
 * without offers, only the count. */
export function heading(result: OffersResult, rows: Row[], now = new Date()) {
  const text = pick(OFFERS);
  const count = text.products(rows.length);
  const first = result.offers[0];
  const exp = Math.min(...result.offers.map((o) => o.claims.exp));
  const at = new Date(exp * 1000);
  return {
    title: first === undefined ? count : `${count} · ${day(first.claims.requestedDate)}`,
    until: Number.isFinite(exp)
      ? text.until(at.toDateString() === now.toDateString() ? timeOnly(at) : when(at, now))
      : null,
  };
}

/**
 * The order limit the pre-checks used: the mandate's gross maxOrderTotal, only while that
 * mandate is active and is the one (id and version) every offer was made under. A revoked or
 * changed mandate gives null: the view then names no amount rather than a wrong one.
 */
export function limitFor(offers: OfferLine[], stored: StoredMandate | null): number | null {
  if (stored === null || stored.status === "revoked" || offers.length === 0) return null;
  const { mandateId, version } = stored.mandate;
  const same = offers.every(
    (o) => o.claims.mandateId === mandateId && o.claims.mandateVersion === version,
  );
  return same ? stored.mandate.limits.maxOrderTotal.value : null;
}

/** The line under the products: each row is checked on its own, so say that the whole
 * order is checked again, by how much it is over the limit when that is known, and that
 * picks that would be rejected are not counted. */
export function orderNote(rows: Row[], limit: number | null): string | null {
  if (!rows.some((row) => row.kind === "offered")) return null;
  const over = overLimit(rows, limit);
  const text = pick(OFFERS);
  const rejected = rows.filter(
    (row) => row.kind === "offered" && row.pick.precheck?.decision === "rejected",
  ).length;
  return [
    over === null || limit === null ? text.eachOnItsOwn : text.together(money(over), money(limit)),
    ...(rejected === 0 ? [] : [text.rejectedNotCounted(rejected)]),
    text.checkedAgain,
  ].join(" ");
}

function approvalText(line: OfferLine): string {
  const check = line.precheck;
  const approval = pick(OFFERS).approval;
  if (check === null) return approval.notChecked;
  if (check.decision === "auto") return approval.notNeeded;
  const head = check.decision === "rejected" ? approval.rejected : approval.needed;
  const reasonText = pick(CARD).reason;
  const reasons = check.reasons.map((r) => reasonText[r]).join(" ");
  return reasons === "" ? head : `${head}. ${reasons}`;
}

function totalText(c: OfferClaims): string {
  const withDeposits = c.depositsIncluded !== false && c.deposits > 0;
  return pick(OFFERS).total(money(c.total.net), money(c.total.gross), withDeposits);
}

function depositText(c: OfferClaims): string {
  const text = pick(OFFERS);
  if (c.depositsIncluded === false) return text.depositsNotGiven;
  return c.deposits > 0 ? text.depositsInTotal(money(c.deposits)) : text.depositsNone;
}

/** "95%" in English, "95 %" in Finnish. */
const percent = (share: number) =>
  new Intl.NumberFormat(intlLocale(), { style: "percent", maximumFractionDigits: 0 }).format(share);

/** The details panel: the offer's facts; a missing value reads "No data", never 0. */
export function details(line: OfferLine): [string, string][] {
  const c = line.claims;
  const pack = c.product.perSalesUnit;
  const origin = c.product.countryOfOrigin?.trim() ?? "";
  const text = pick(OFFERS);
  const label = text.labels;
  const noData = text.noData;
  const language = lang();
  return [
    [label.total, totalText(c)],
    [label.deposits, depositText(c)],
    [label.amount, formatQuantity(c.quantity, language)],
    [label.pack, pack === null ? noData : text.pack(amount(pack), money(c.unitPrice.net))],
    [label.pricePerStd, pricePerStdUnit(c)?.shown ?? noData],
    [label.delivery, formatDeliveryDate(c.deliveryDate, language)],
    [label.orderBy, c.cutoffAt === null ? noData : formatTimestamp(c.cutoffAt, language)],
    [label.stock, c.stock === "confirmed" ? text.confirmed : text.notConfirmed],
    [
      label.reliability,
      c.product.deliveryReliability === null ? noData : percent(c.product.deliveryReliability),
    ],
    [label.co2, c.product.co2PerKg === null ? noData : text.co2(number(c.product.co2PerKg))],
    [label.origin, origin === "" ? noData : origin.toUpperCase()],
    [label.approval, approvalText(line)],
  ];
}

/**
 * The chat text of a "Use". A substitute covers the shortfall, not the whole line: "For the
 * missing 16 l of Test milk 1 l, use Test organic milk 1 l." Without a shortfall on the row's
 * pick: "For Test milk 1 l, use Test organic milk 1 l instead."
 */
export function useText(row: Row, option: Option): string {
  const text = pick(OFFERS);
  const product = option.line.claims.product.name;
  const short = row.kind === "offered" ? row.pick.claims.shortfall : null;
  return option.line.claims.replaces !== null && short !== null
    ? text.useForMissing(amount(short), row.name, product)
    : text.useText(row.name, product);
}
export const askElseText = (row: Row) => pick(OFFERS).askElseText(row.name);
export const retryText = (row: Row) => pick(OFFERS).retryText(row.name);

// The open product and the messages asked, as pure transitions.

export type Panel = "summary" | "options" | "details";

export type Ui = {
  /** One product open at a time; `offerId` is the option whose details are shown. */
  open: { key: string; panel: Panel; offerId: string | null } | null;
  /** The links whose message reached the chat: they show "Asked ✓". */
  asked: readonly string[];
  /** The link whose message is on its way; every other steering link waits. */
  sending: { id: string; key: string } | null;
  /** The product whose message did not reach the chat; its text is read at render time. */
  error: { key: string } | null;
  /** True when the source can post a chat message (`source.message`). */
  canSteer: boolean;
};

export const closed: Ui = { open: null, asked: [], sending: null, error: null, canSteer: false };

/** The English text of a message the chat did not take. */
export const SEND_FAILED = OFFERS.en.sendFailed;

/** Opens a product at its summary, or closes it when it is open. */
export const toggle = (ui: Ui, key: string): Ui => ({
  ...ui,
  open: ui.open?.key === key ? null : { key, panel: "summary", offerId: null },
});

/** Shows a panel of the open product (details of `offerId`, else of its pick), or hides it
 * when the same panel is asked for again. */
export function show(ui: Ui, panel: Panel, offerId: string | null = null): Ui {
  if (ui.open === null) return ui;
  const same = ui.open.panel === panel && ui.open.offerId === offerId;
  return { ...ui, open: { ...ui.open, panel: same ? "summary" : panel, offerId } };
}

/** A steering link was clicked; null when a message is already on its way or this one was
 * already asked. */
export function sending(ui: Ui, id: string, key: string): Ui | null {
  if (ui.sending !== null || ui.asked.includes(id)) return null;
  return { ...ui, sending: { id, key }, error: ui.error?.key === key ? null : ui.error };
}

/** The chat took the message: the link shows "Asked ✓" and the others are free again. */
export const sent = (ui: Ui): Ui =>
  ui.sending === null ? ui : { ...ui, asked: [...ui.asked, ui.sending.id], sending: null };

/** The chat did not take it: the link is free again and its product shows why. */
export const failed = (ui: Ui): Ui =>
  ui.sending === null ? ui : { ...ui, sending: null, error: { key: ui.sending.key } };

/** A steering link's state, also its CSS class. */
export type LinkState = "asked" | "sending" | "enabled" | "disabled";

/** A steering link: asked (✓), on its way, waiting while another message is, or enabled. */
export function linkState(id: string, ui: Pick<Ui, "asked" | "sending">): LinkState {
  if (ui.asked.includes(id)) return "asked";
  if (ui.sending?.id === id) return "sending";
  return ui.sending === null ? "enabled" : "disabled";
}

/** What the screen reader hears after a steering link of a product: on its way, sent, or
 * nothing after a failure (the error alert says it). */
export function steerStatus(row: OfferedRow, ui: Ui): "sending" | "sent" | null {
  if (ui.sending?.key === row.key) return "sending";
  if (ui.error?.key === row.key) return null;
  const ids = [...row.options.map((o) => o.line.offerId), `else:${row.key}`, `retry:${row.key}`];
  const latest = ui.asked.at(-1);
  return latest !== undefined && ids.includes(latest) ? "sent" : null;
}
