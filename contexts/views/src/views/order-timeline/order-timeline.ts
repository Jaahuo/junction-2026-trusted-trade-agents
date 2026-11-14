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
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import agent16 from "../../shared/icons/agent-16.svg?raw";
import { lang, pick } from "../../shared/locale.ts";
import { base } from "../../shared/styles.ts";
import { statusDisc, type Tone, trustStyles } from "../../shared/trust.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

import { TIMELINE } from "./strings.ts";

/** The audit integrity strip (#74): the server's signature check of the whole log. */
function integrityStrip(order: Order) {
  const integrity = order.auditIntegrity;
  if (integrity === undefined) return nothing;
  const text = pick(TIMELINE);
  const changed = order.audit.filter((e) => e.integrityOk === false).length;
  const [tone, message]: [Tone, string] =
    integrity === "intact"
      ? ["success", text.logIntact(order.audit.length)]
      : integrity === "unverified"
        ? ["warning", text.logUnverified]
        : ["danger", text.logBroken(changed)];
  return html`<p class="strip ${tone} strong" role="status" aria-live="polite">
    ${statusDisc(tone, true)}<span>${message}</span>
  </p>`;
}

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
    <section class="log" aria-label=${text.orderLog}>
      <h3>${text.orderLog}</h3>
      ${integrityStrip(order)}
      ${
        order.audit.length === 0
          ? html`<p class="secondary">${text.noActivity}</p>`
          : html`<ol class="events">
              ${order.audit.map(
                (event) =>
                  html`<li class=${event.integrityOk === false ? "broken" : ""}>
                    <p class="label-small secondary event-meta">
                      ${
                        event.actor === "agent"
                          ? html`<span class="agent" aria-hidden="true"
                              >${unsafeSVG(agent16)}</span
                            >`
                          : nothing
                      }<time datetime=${event.at}>${formatTimestamp(event.at, l)}</time>
                      · ${words.actors[event.actor]}
                    </p>
                    <h4 class="body-small">${text.events[event.event]}</h4>
                    ${event.reason ? html`<p class="body-small">${text.reason[event.reason]}</p>` : nothing}
                    ${event.rule ? html`<span class="body-small" title=${event.rule}>${text.supportRule}</span>` : nothing}
                    ${event.detail ? html`<p class="body-small">${event.detail}</p>` : nothing}
                    ${
                      event.integrityOk === false
                        ? html`<p class="strong tampered">${text.entryChanged}</p>`
                        : nothing
                    }
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
    trustStyles,
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
      .log .strip {
        margin-bottom: var(--spacing-lg);
      }
      /* Entries, oldest first: an 8 px dot, "time · actor", then the event. */
      .events {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }
      .events li {
        position: relative;
        padding: var(--spacing-xs) var(--spacing-sm) var(--spacing-xs) var(--spacing-xl);
        border-radius: var(--border-radius-md);
      }
      .events li::before {
        position: absolute;
        top: 7px;
        left: var(--spacing-sm);
        width: 8px;
        height: 8px;
        border-radius: var(--radius-full);
        background: var(--color-border-strong);
        content: "";
      }
      .events li.broken {
        background: var(--color-bg-danger);
      }
      .events li.broken::before {
        background: var(--color-text-danger);
      }
      .event-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-2xs);
      }
      .event-meta .agent {
        display: inline-flex;
        color: var(--color-text-brand);
      }
      .event-meta .agent svg {
        width: 12px;
        height: 12px;
      }
      .events h4 {
        font-weight: 400;
      }
      .tampered {
        margin-top: var(--spacing-xs);
        color: var(--color-text-danger);
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
