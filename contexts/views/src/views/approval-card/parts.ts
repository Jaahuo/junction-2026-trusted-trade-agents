import type { OfferClaims } from "@app/contract";
import { css, html, nothing, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import attention16 from "../../shared/icons/attention-16.svg?raw";
import logo from "../../shared/icons/logo-valio-aimo.svg?raw";

// Parts that the card and the view share: the petrol header, the card frame and
// the formatters. Figma: Junction 2026 › Screens › "Approval request — v8".

const UNIT: Record<string, string> = {
  LTR: "l",
  KGM: "kg",
  GRM: "g",
  CT: "packs",
  PCE: "pcs",
  ST: "pcs",
};
/** "packs", "kg": the short name of a unit code. */
export const unit = (code: string) => UNIT[code] ?? code;

const euro = (digits: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  });
/** Totals: "€1,428", or "€57.60" when there are cents. */
export const money = (value: number) => euro(value % 1 === 0 ? 0 : 2).format(value);
export const number = (value: number) => new Intl.NumberFormat("en-GB").format(value);
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
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(
    new Date(date),
  );
const clock = (at: Date) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(at);
/** "Today 21:40", or "14 Nov, 21:40" on another day. */
export const when = (at: Date, now = new Date()) =>
  at.toDateString() === now.toDateString()
    ? `Today ${clock(at)}`
    : `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at)}, ${clock(at)}`;
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
 * The petrol header: logo with the eyebrow (or, v17, a yellow status pill), then a title row
 * and optional facts.
 */
export const brandHeader = (
  eyebrow: string,
  title?: TemplateResult,
  facts?: TemplateResult,
  pill = false,
) =>
  html`<header class="header" part="header">
    <div class="eyebrow-row ${pill ? "spread" : ""}">
      ${icon(logo, "Valio Aimo")}
      ${
        pill
          ? html`<span class="pill" part="status">${icon(attention16)}${eyebrow}</span>`
          : html`<span class="divider" aria-hidden="true"></span>
              <p class="label-small eyebrow">${eyebrow}</p>`
      }
    </div>
    ${title ?? nothing} ${facts ?? nothing}
  </header>`;

/** One labelled data point; `wrap` lets a long value (a real product name) break lines. */
export const fact = (label: string, value: string, wrap = false) =>
  html`<div class="fact ${wrap ? "wrap" : ""}">
    <dt class="label-small">${label}</dt>
    <dd>${value}</dd>
  </div>`;

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
  .pill {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs);
    padding: var(--spacing-xs) var(--spacing-md) var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-full);
    background: var(--color-yellow-aimo);
    color: var(--color-text);
    font-size: var(--font-size-2xs);
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: 0.2px;
    white-space: nowrap;
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
