import type { Order } from "@app/contract";
import {
  formatDeliveryDate,
  formatMoney,
  formatOrderNumber,
  formatQuantity,
  formatTimestamp,
  ORDER_WORDING,
} from "@app/ui/format";
import { css, html, nothing, type TemplateResult } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { lang, pick } from "../../shared/locale.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

import { TIMELINE } from "./strings.ts";

/** Render the order record without adding actions to the audit view. */
export function renderOrderTimeline(order: Order): TemplateResult {
  const decision = order.decision;
  const text = pick(TIMELINE);
  const words = pick(ORDER_WORDING);
  const l = lang();
  return html`<section class="timeline" part="done">
    <header class="header">
      <div>
        <p class="eyebrow">${text.eyebrow}</p>
        <h2 title=${order.orderId}>${text.order(formatOrderNumber(order.orderId, l))}</h2>
      </div>
      <p class="status">${words.statuses[order.status]}</p>
    </header>
    <section class="decision" aria-label=${text.summaryLabel}>
      <h3>${text.summaryLabel}</h3>
      <p>${text.total(formatMoney(order.total.gross, "EUR", "gross", l))}</p>
      <ul>
        ${order.lines.map(
          ({ claims }) =>
            html`<li>
              <p class="strong" title=${claims.productId}>${claims.product.name}</p>
              <p>
                <span title=${claims.quantity.unit}>${formatQuantity(claims.quantity, l)}</span> ·
                ${formatDeliveryDate(claims.deliveryDate, l)}
              </p>
            </li>`,
        )}
      </ul>
    </section>
    ${order.status === "placed" ? html`<p class="decision">${words.outcomes.placed}</p>` : nothing}
    ${
      decision?.action === "reject"
        ? html`<div class="decision">
            <p class="strong">${text.approvalDeclined}</p>
            <p>
              ${
                decision.next === "stop"
                  ? words.outcomes.stop
                  : decision.next === "alternatives"
                    ? words.outcomes.alternatives
                    : text.nextNotRecorded
              }
            </p>
            ${decision.note ? html`<p>${text.note(decision.note)}</p>` : nothing}
          </div>`
        : nothing
    }
    <section aria-label=${text.auditEvents}>
      <h3>${text.activity}</h3>
      ${
        order.audit.length === 0
          ? html`<p class="secondary">${text.noActivity}</p>`
          : html`<ol class="events">
              ${order.audit.map(
                (event) =>
                  html`<li>
                    <div class="event-heading">
                      <h4>${text.events[event.event]}</h4>
                      <span class="secondary body-small">
                        <time datetime=${event.at}>${formatTimestamp(event.at, l)}</time>
                      </span>
                    </div>
                    <p class="secondary body-small">${words.actors[event.actor]}</p>
                    ${event.reason ? html`<p>${text.reason[event.reason]}</p>` : nothing}
                    ${event.rule ? html`<span class="body-small" title=${event.rule}>${text.supportRule}</span>` : nothing}
                    ${event.detail ? html`<p class="body-small">${event.detail}</p>` : nothing}
                  </li>`,
              )}
            </ol>`
      }
    </section>
    ${
      order.requotes.length === 0
        ? nothing
        : html`<section class="requotes" aria-label=${text.requotedOffers}>
            <h3>${text.requotedOffers}</h3>
            <ul>
              ${order.requotes.map(
                (quote) =>
                  html`<li>
                    <p class="strong" title=${quote.current.productId}>
                      ${quote.current.product.name}
                    </p>
                    ${
                      quote.previous.productId !== quote.current.productId
                        ? html`<p class="body-small" title=${quote.previous.productId}>
                            ${text.previousProduct(quote.previous.product.name)}
                          </p>`
                        : nothing
                    }
                    <p>
                      ${text.unitPrice}
                      ${formatMoney(quote.previous.unitPrice.net, quote.previous.unitPrice.currency, "net", l)}
                      →
                      ${formatMoney(quote.current.unitPrice.net, quote.current.unitPrice.currency, "net", l)}
                    </p>
                    <p>
                      ${text.totalLabel}
                      ${formatMoney(quote.previous.total.gross, quote.previous.unitPrice.currency, "gross", l)}
                      →
                      ${formatMoney(quote.current.total.gross, quote.current.unitPrice.currency, "gross", l)}
                    </p>
                    <p class="secondary body-small">
                      <time datetime=${quote.at}>${formatTimestamp(quote.at, l)}</time>
                    </p>
                    ${quote.reasons.map((reason) => html`<p>${text.reason[reason]}</p>`)}
                  </li>`,
              )}
            </ul>
          </section>`
    }
  </section>`;
}

class OrderTimeline extends ViewElement<ViewEntryOf<"order-timeline">> {
  static override styles = [
    base,
    css`
      .timeline {
        padding: var(--spacing-xl);
        border: 1px solid var(--color-border);
        border-radius: var(--border-radius-lg);
        background: var(--color-white);
        overflow-wrap: anywhere;
      }
      .header {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--spacing-md);
        margin-bottom: var(--spacing-xl);
      }
      .header > div {
        min-width: 0;
      }
      .eyebrow {
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
      }
      h2 {
        color: var(--color-heading);
        font-size: var(--font-size-xl);
        font-weight: 700;
      }
      h3 {
        margin-bottom: var(--spacing-md);
        color: var(--color-heading);
        font-weight: 700;
      }
      h4 {
        font-weight: 700;
      }
      .status {
        padding: var(--spacing-xs) var(--spacing-md);
        border-radius: var(--radius-full);
        background: var(--color-bg-brand-subtle);
        color: var(--color-text-brand);
        font-size: var(--font-size-xs);
        font-weight: 700;
      }
      .decision {
        margin-bottom: var(--spacing-xl);
        padding: var(--spacing-md);
        border-radius: var(--border-radius-md);
        background: var(--color-bg-subtle);
      }
      .decision p + p,
      li p + p {
        margin-top: var(--spacing-xs);
      }
      .events,
      .requotes ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .events li {
        padding: 0 0 var(--spacing-lg) var(--spacing-lg);
        border-left: 2px solid var(--color-border-brand);
      }
      .events li:last-child {
        padding-bottom: 0;
      }
      .event-heading {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: var(--spacing-xs) var(--spacing-md);
      }
      .requotes {
        margin-top: var(--spacing-xl);
      }
      .requotes li {
        padding: var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--border-radius-md);
      }
      .requotes li + li {
        margin-top: var(--spacing-sm);
      }
    `,
  ];
  readonly entry = viewEntry("order-timeline");

  protected override renderDone(order: ViewData<"order-timeline">) {
    return renderOrderTimeline(order);
  }
}

export const defineOrderTimeline = () => defineView("tt-order-timeline", OrderTimeline);

declare global {
  interface HTMLElementTagNameMap {
    "tt-order-timeline": OrderTimeline;
  }
}
