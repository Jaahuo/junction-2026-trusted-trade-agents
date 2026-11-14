import { type Order, REASON_TEXT } from "@app/contract";
import {
  formatDeliveryDate,
  formatMoney,
  formatOrderNumber,
  formatQuantity,
  formatTimestamp,
  ORDER_ACTORS,
  ORDER_OUTCOMES,
  ORDER_STATUS_LABELS,
} from "@app/ui/format";
import { css, html, nothing, type TemplateResult } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

const events: Record<Order["audit"][number]["event"], string> = {
  order_requested: "Order requested",
  order_refused: "Order refused",
  offer_verified: "Offer verified",
  check_passed: "Check passed",
  check_failed: "Check failed",
  sent_to_approval: "Sent for approval",
  approved: "Approved",
  declined: "Declined",
  requoted: "Offer requoted",
  edited: "Order edited",
  payment_authorized: "Payment authorized",
  payment_failed: "Payment failed",
  placed: "Order placed",
  rejected: "Order rejected",
};

/** Render the order record without adding actions to the audit view. */
export function renderOrderTimeline(order: Order): TemplateResult {
  const decision = order.decision;
  return html`<section class="timeline" part="done">
    <header class="header">
      <div>
        <p class="eyebrow">Order timeline</p>
        <h2 title=${order.orderId}>Order ${formatOrderNumber(order.orderId)}</h2>
      </div>
      <p class="status">${ORDER_STATUS_LABELS[order.status]}</p>
    </header>
    <section class="decision" aria-label="Order summary">
      <h3>Order summary</h3>
      <p>Total: ${formatMoney(order.total.gross, "EUR", "gross")}</p>
      <ul>
        ${order.lines.map(
          ({ claims }) =>
            html`<li>
              <p class="strong" title=${claims.productId}>${claims.product.name}</p>
              <p>
                <span title=${claims.quantity.unit}>${formatQuantity(claims.quantity)}</span> ·
                ${formatDeliveryDate(claims.deliveryDate)}
              </p>
            </li>`,
        )}
      </ul>
    </section>
    ${order.status === "placed" ? html`<p class="decision">${ORDER_OUTCOMES.placed}</p>` : nothing}
    ${
      decision?.action === "reject"
        ? html`<div class="decision">
            <p class="strong">Approval declined</p>
            <p>
              ${
                decision.next === "stop"
                  ? ORDER_OUTCOMES.stop
                  : decision.next === "alternatives"
                    ? ORDER_OUTCOMES.alternatives
                    : "The next action was not recorded."
              }
            </p>
            ${decision.note ? html`<p>Note: ${decision.note}</p>` : nothing}
          </div>`
        : nothing
    }
    <section aria-label="Audit events">
      <h3>Activity</h3>
      ${
        order.audit.length === 0
          ? html`<p class="secondary">No activity recorded.</p>`
          : html`<ol class="events">
              ${order.audit.map(
                (event) =>
                  html`<li>
                    <div class="event-heading">
                      <h4>${events[event.event]}</h4>
                      <span class="secondary body-small">
                        <time datetime=${event.at}>${formatTimestamp(event.at)}</time>
                      </span>
                    </div>
                    <p class="secondary body-small">${ORDER_ACTORS[event.actor]}</p>
                    ${event.reason ? html`<p>${REASON_TEXT[event.reason]}</p>` : nothing}
                    ${event.rule ? html`<span class="body-small" title=${event.rule}>Support rule available</span>` : nothing}
                    ${event.detail ? html`<p class="body-small">${event.detail}</p>` : nothing}
                  </li>`,
              )}
            </ol>`
      }
    </section>
    ${
      order.requotes.length === 0
        ? nothing
        : html`<section class="requotes" aria-label="Requoted offers">
            <h3>Requoted offers</h3>
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
                            Previous product: ${quote.previous.product.name}
                          </p>`
                        : nothing
                    }
                    <p>
                      Unit price:
                      ${formatMoney(quote.previous.unitPrice.net, quote.previous.unitPrice.currency, "net")}
                      →
                      ${formatMoney(quote.current.unitPrice.net, quote.current.unitPrice.currency, "net")}
                    </p>
                    <p>
                      Total:
                      ${formatMoney(quote.previous.total.gross, quote.previous.unitPrice.currency, "gross")}
                      →
                      ${formatMoney(quote.current.total.gross, quote.current.unitPrice.currency, "gross")}
                    </p>
                    <p class="secondary body-small">
                      <time datetime=${quote.at}>${formatTimestamp(quote.at)}</time>
                    </p>
                    ${quote.reasons.map((reason) => html`<p>${REASON_TEXT[reason]}</p>`)}
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
