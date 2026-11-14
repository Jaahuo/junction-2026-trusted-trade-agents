import type { OfferClaims, OfferLine, OffersResult } from "@app/contract";
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

/** What a steering link does: the agent's pick is marked, a rejected offer has nothing. */
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
/** "L" and "kg", as the design writes a price per standard unit. */
const STD_UNIT: Record<string, string> = { LTR: "L", KGM: "kg", KG: "kg" };
const perStd = (code: string) => STD_UNIT[code] ?? unit(code);

/** Total net / (quantity × perSalesUnit): "€1.20/L"; null when the pack size is unknown. */
export function pricePerStdUnit(claims: OfferClaims): Price | null {
  const pack = claims.product.perSalesUnit;
  const std = pack === null ? 0 : claims.quantity.value * pack.value;
  if (pack === null || !(std > 0)) return null;
  const value = twoDecimals(claims.total.net / std);
  const text = pick(OFFERS);
  const per = text.perSpoken[pack.unit] ?? text.perOther(unit(pack.unit));
  return { shown: `${value}/${perStd(pack.unit)}`, spoken: `${value} ${per}` };
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

/** The short reason a row shows, or null when nothing needs a look. Never null when the
 * pre-check asks for approval or rejects, even without a reason code. */
export function shortReason(line: OfferLine): string | null {
  const check = line.precheck;
  const text = pick(OFFERS);
  if (check === null) return text.notChecked;
  if (check.decision !== "auto") {
    const first = check.reasons[0];
    if (first !== undefined) return text.short[first];
    return check.decision === "rejected" ? text.wouldBeRejected : text.needsApproval;
  }
  const part = partly(line.claims);
  if (part !== null) return part;
  const late = daysLate(line.claims);
  return late > 0 ? lateText(late) : null;
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

/** The gross total of the agent's picks: what the order would cost. */
function picksTotal(rows: Row[]): number {
  return rows.reduce(
    (sum, row) => (row.kind === "offered" ? sum + row.pick.claims.total.gross : sum),
    0,
  );
}

/** How far the whole order (the agent's picks) is over the mandate's gross limit; null when
 * the limit is unknown or the order is within it. */
export function overLimit(rows: Row[], limit: number | null): number | null {
  if (limit === null) return null;
  const over = Math.round((picksTotal(rows) - limit) * 100) / 100;
  return over > 0 ? over : null;
}

/**
 * What would happen if the agent ordered this offer: the pre-check, then a partial delivery
 * and a late date when they apply. An order over the limit names the amount when `over` is
 * known.
 */
export function explain(line: OfferLine, over: number | null = null): string {
  const check = line.precheck;
  const text = pick(OFFERS);
  const reasonText = pick(CARD).reason;
  const sentences: string[] = [];
  if (check === null) sentences.push(text.noAnswer);
  else if (check.decision === "auto") sentences.push(text.autoSentence);
  else {
    const head = check.decision === "rejected" ? text.wouldBeRejected : text.needsYourApproval;
    const [only, ...more] = check.reasons;
    sentences.push(
      only === undefined
        ? `${head}.`
        : more.length > 0
          ? `${head}. ${check.reasons.map((r) => reasonText[r]).join(" ")}`
          : only === "SPEND_OVER_LIMIT" && over !== null
            ? text.overYourLimit(head, money(over))
            : `${head}: ${lowerFirst(reasonText[only])}`,
    );
  }
  const part = partly(line.claims);
  if (part !== null) sentences.push(text.onlyPart(part));
  const late = daysLate(line.claims);
  if (late > 0) sentences.push(text.arrives(day(line.claims.deliveryDate), lateText(late)));
  return sentences.join(" ");
}

/** "+5 pts reliability · €0.10/L cheaper · other origin", or null without a comparison. */
function differsText(line: OfferLine): string | null {
  const c = line.comparison;
  if (c === null) return null;
  const pack = line.claims.product.perSalesUnit;
  const per = pack === null ? "" : `/${perStd(pack.unit)}`;
  const reliability = c.reliabilityDelta;
  const price = c.pricePerStdUnitDelta;
  const text = pick(OFFERS);
  const parts = [
    reliability === null || reliability === 0
      ? null
      : text.reliabilityDelta(reliability > 0 ? "+" : "−", Math.round(Math.abs(reliability) * 100)),
    price === null || price === 0
      ? null
      : text.priceDelta(`${twoDecimals(Math.abs(price))}${per}`, price > 0),
    c.originDiffers === true ? text.otherOrigin : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A substitute that needs approval only for being a substitute shows its rank in words. */
function optionReason(line: OfferLine): string | null {
  const onlySubstitution =
    line.precheck !== null &&
    line.precheck.decision !== "rejected" &&
    line.precheck.reasons.every((r) => r === "SUBSTITUTION");
  return line.rank !== null && onlySubstitution && partly(line.claims) === null
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
 * then one ranked block of substitutes per original, each block starting again at its best.
 * Two lines of the same product are two groups.
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
    const owners = groups.filter((g) => g.original !== null && g.productId === replaces);
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

/** The line under the products: each row is checked on its own, so say that the whole
 * order is checked again, and by how much it is over the limit when that is known. */
export function orderNote(rows: Row[], limit: number | null): string | null {
  if (!rows.some((row) => row.kind === "offered")) return null;
  const over = overLimit(rows, limit);
  const text = pick(OFFERS);
  return over === null || limit === null
    ? `${text.eachOnItsOwn} ${text.checkedAgain}`
    : `${text.together(money(over), money(limit))} ${text.checkedAgain}`;
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

/** The chat text of a "Use": "For Test milk 1 l, use Test organic milk 1 l instead." */
export const useText = (row: Row, option: Option) =>
  pick(OFFERS).useText(row.name, option.line.claims.product.name);
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
  /** A message that did not reach the chat, shown under the product it was about. */
  error: { key: string; message: string } | null;
  /** Messages reach a chat only inside a host. */
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
  ui.sending === null
    ? ui
    : { ...ui, sending: null, error: { key: ui.sending.key, message: pick(OFFERS).sendFailed } };

/** A steering link: asked (✓), on its way, waiting while another message is, or enabled. */
export function linkState(id: string, ui: Pick<Ui, "asked" | "sending">) {
  if (ui.asked.includes(id)) return "asked" as const;
  if (ui.sending?.id === id) return "sending" as const;
  return ui.sending === null ? ("enabled" as const) : ("disabled" as const);
}
