import type { OfferClaims, Order } from "@app/contract";
import { brand } from "@app/ui/brand";
import { formatOrderNumber, ORDER_WORDING } from "@app/ui/format";
import { css, html, nothing, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import attention16 from "../../shared/icons/attention-16.svg?raw";
import { intlLocale, lang, pick } from "../../shared/locale.ts";
import { CARD } from "./card-strings.ts";
import { productImage } from "./images.ts";
import { PARTS, VIEW } from "./strings.ts";

// Parts that the card and the view share: the petrol header, the card frame and
// the formatters. Figma: Junction 2026 › Screens › "Approval request — v8".

const UNIT: Record<string, string> = { LTR: "l", KGM: "kg", KG: "kg", GRM: "g" };
/** "packs", "kg": the short name of a unit code. */
export const unit = (code: string) => UNIT[code] ?? pick(PARTS).units[code] ?? code;

const euro = (digits: number) =>
  new Intl.NumberFormat(intlLocale(), {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  });
/** Totals: "€1,428", or "€57.60" when there are cents. */
export const money = (value: number) => euro(value % 1 === 0 ? 0 : 2).format(value);
export const number = (value: number) => new Intl.NumberFormat(intlLocale()).format(value);
/** "1,008 l", "120 kg"; below one kilogram or litre in grams or millilitres ("500 g"). */
export const amount = (q: { value: number; unit: string }) =>
  q.value > 0 && q.value < 1 && (q.unit === "KGM" || q.unit === "LTR")
    ? `${number(Math.round(q.value * 1000))} ${q.unit === "KGM" ? "g" : "ml"}`
    : `${number(q.value)} ${unit(q.unit)}`;
/** The line in standard units (litres, kilograms), or sales units when the pack size is unknown. */
export const stdUnits = (c: OfferClaims) =>
  c.product.perSalesUnit === null
    ? c.quantity
    : { value: c.quantity.value * c.product.perSalesUnit.value, unit: c.product.perSalesUnit.unit };
export const day = (date: string) =>
  new Intl.DateTimeFormat(intlLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(date));
/** "Order for Mon 16 Nov": an order named by its earliest delivery day. */
export const orderName = (order: Order) => {
  const earliest = order.lines.map((l) => l.claims.deliveryDate).toSorted()[0];
  return earliest === undefined ? pick(VIEW).order : pick(VIEW).orderFor(day(earliest));
};
/** The VAT label that goes after a total: net totals exclude VAT, gross ones include it. */
export const vat = (basis: "net" | "gross") => pick(PARTS).vat[basis];
const clock = (at: Date) =>
  new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit" }).format(at);
/** "Today 21:40", or "14 Nov, 21:40" on another day. */
export const when = (at: Date, now = new Date()) =>
  at.toDateString() === now.toDateString()
    ? `${pick(PARTS).today} ${clock(at)}`
    : `${new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short" }).format(at)}, ${clock(at)}`;
export const timeOnly = clock;

export const icon = (svg: string, label?: string) =>
  html`<span
    class="icon"
    role=${label === undefined ? "presentation" : "img"}
    aria-label=${label ?? nothing}
    aria-hidden=${label === undefined ? "true" : "false"}
    >${unsafeSVG(svg)}</span
  >`;

/**
 * The petrol header: logo with the eyebrow (or, v17, a yellow status pill; or nothing when the
 * eyebrow is empty), then a title row and optional facts.
 */
export const brandHeader = (
  eyebrow: string,
  title?: TemplateResult,
  facts?: TemplateResult,
  pill = false,
) =>
  html`<header class="header" part="header">
    <div class="eyebrow-row ${pill ? "spread" : ""}">
      <img src=${brand.logo} alt=${brand.name} />
      ${
        pill
          ? html`<span class="pill" part="status">${icon(attention16)}${eyebrow}</span>`
          : eyebrow === ""
            ? nothing
            : html`<span class="divider" aria-hidden="true"></span>
                <p class="label-small eyebrow">${eyebrow}</p>`
      }
    </div>
    ${title ?? nothing} ${facts ?? nothing}
  </header>`;

/** A product's 48 px (or 40 px in a choice) image tile; nothing when it has no image. */
export const thumb = (name: string, size: "line" | "small" = "line") => {
  const src = productImage(name);
  return src === null
    ? nothing
    : html`<span class="thumb ${size}"><img src=${src} alt="" /></span>`;
};

/** One labelled data point; `wrap` lets a long value (a real product name) break lines. */
const fact = (label: string, value: string, wrap = false) =>
  html`<div class="fact ${wrap ? "wrap" : ""}">
    <dt class="label-small">${label}</dt>
    <dd>${value}</dd>
  </div>`;

/** The header's word for a decided or waiting order: "Approved", "Declined", "Approval required". */
export const orderStateLabel = (order: Order) => {
  const text = pick(CARD);
  if (order.status === "placed") return text.approved;
  if (order.status === "awaiting_payment") return text.approvedWaiting;
  if (order.status === "pending_approval") return text.approvalRequired;
  return ORDER_WORDING[lang()].statuses[order.status];
};

/**
 * The order header of the card and the timeline (v16): the state, the order named by its
 * delivery day, the net total, and the order number and product count.
 */
export const orderHeader = (order: Order, eyebrow: string, net: number, pill: boolean) => {
  const text = pick(CARD);
  const title = html`<div class="headline">
    <h2 class="name">${orderName(order)}</h2>
    <p aria-live="polite">${money(net)}<span class="vat">${vat("net")}</span></p>
  </div>`;
  const facts = html`<dl class="facts">
    ${fact(text.orderNo, formatOrderNumber(order.orderId))}
    ${fact(text.products, String(order.lines.length))}
  </dl>`;
  return brandHeader(eyebrow, title, facts, pill);
};

export const rows = (entries: [string, string | null][]) => {
  const shown = entries.filter((r): r is [string, string] => r[1] !== null);
  return shown.length === 0
    ? nothing
    : html`<dl class="rows body-small">
        ${shown.map(
          ([label, value]) =>
            html`<div class="row">
              <dt>${label}</dt>
              <dd>${value}</dd>
            </div>`,
        )}
      </dl>`;
};

export const cardStyles = css`
  :host {
    container-type: inline-size;
  }
  /* v12: flat Aimo cards, no radius and no shadow. */
  .card {
    overflow: hidden;
    border: 1px solid var(--color-border);
    background: var(--color-white);
  }
  .header {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
    padding: var(--spacing-xl);
    background: var(--color-bg-brand);
    color: var(--color-text-on-brand);
  }
  /* v11: logo first, a thin divider, then the eyebrow. */
  .eyebrow-row {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
  }
  /* v17 dev notes: logo left, status pill right. */
  .eyebrow-row.spread {
    justify-content: space-between;
  }
  .divider {
    width: 1px;
    height: 14px;
    background: var(--color-text-on-brand-subtle);
  }
  .eyebrow {
    color: var(--color-text-on-brand-subtle);
  }
  /* v13 Heading/H2: Barlow Condensed bold 32/1. */
  .headline,
  .header .title {
    font-family: var(--font-family-condensed);
    font-size: 32px;
    font-weight: 700;
    line-height: 1;
  }
  .headline {
    display: flex;
    gap: var(--spacing-lg);
  }
  .headline .name {
    flex: 1;
    min-width: 0;
  }
  .headline .vat {
    display: block;
    color: var(--color-text-on-brand-subtle);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-2xs);
    font-weight: 600;
    text-align: right;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-sm) var(--spacing-2xl);
    font-weight: 600;
    white-space: nowrap;
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-2xs);
  }
  .fact.wrap {
    flex: 1 1 12rem;
    min-width: 0;
    white-space: normal;
  }
  .header .fact dt {
    color: var(--color-text-on-brand-subtle);
  }
  .thumb {
    flex-shrink: 0;
    width: 48px;
    height: 48px;
    overflow: hidden;
    border-radius: 6px;
  }
  .thumb.small {
    width: 40px;
    height: 40px;
  }
  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scale(1.5);
  }
  .section-title {
    color: var(--color-heading);
    font-family: var(--font-family-condensed);
    font-size: 20px;
    font-weight: 700;
    line-height: 1.1;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xl);
    padding: var(--spacing-xl);
  }
  .icon {
    display: inline-flex;
    flex-shrink: 0;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }
  .row {
    display: flex;
    gap: var(--spacing-md);
  }
  .row dt {
    flex-shrink: 0;
    width: 112px;
    color: var(--color-text-secondary);
  }
  .row dd {
    flex: 1;
    min-width: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-sm);
  }
`;
