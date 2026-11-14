import { type Order, REASON_TEXT } from "@app/contract";
import { css, html, nothing, type TemplateResult } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

const statuses: Record<Order["status"], string> = {
  pending_approval: "Pending approval",
  awaiting_payment: "Awaiting payment",
  placed: "Placed",
  rejected: "Rejected",
  declined: "Declined",
};

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

const actors: Record<Order["audit"][number]["actor"], string> = {
  agent: "Agent",
  server: "Server",
  approver: "Approver",
};

/** Render the order record without adding actions to the audit view. */
export function renderOrderTimeline(order: Order): TemplateResult {
  const decision = order.decision;
  return html`<section class="timeline" part="done">
    <header class="header">
      <div>
        <p class="eyebrow">Order timeline</p>
        <h2>Order ${order.orderId}</h2>
      </div>
      <p class="status">${statuses[order.status]}</p>
    </header>
    ${
      decision?.action === "reject"
        ? html`<div class="decision">
            <p class="strong">Approval declined</p>
            <p>
              ${
                decision.next === "stop"
                  ? "The agent stops."
                  : decision.next === "alternatives"
                    ? "The agent may seek alternatives."
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
                        <time datetime=${event.at}>${new Date(event.at).toLocaleString()}</time>
                      </span>
                    </div>
                    <p class="secondary body-small">${actors[event.actor]}</p>
                    ${event.reason ? html`<p>${REASON_TEXT[event.reason]}</p>` : nothing}
                    ${event.rule ? html`<p class="body-small">Rule: ${event.rule}</p>` : nothing}
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
                    <p class="strong">${quote.current.product.name} (${quote.current.productId})</p>
                    ${
                      quote.previous.productId !== quote.current.productId
                        ? html`<p class="body-small">
                            Previous product: ${quote.previous.product.name}
                            (${quote.previous.productId})
                          </p>`
                        : nothing
                    }
                    <p>
                      Unit price, net: ${quote.previous.unitPrice.net.toFixed(2)}
                      ${quote.previous.unitPrice.currency} →
                      ${quote.current.unitPrice.net.toFixed(2)} ${quote.current.unitPrice.currency}
                    </p>
                    <p>
                      Total, gross: ${quote.previous.total.gross.toFixed(2)}
                      ${quote.previous.unitPrice.currency} → ${quote.current.total.gross.toFixed(2)}
                      ${quote.current.unitPrice.currency}
                    </p>
                    <p class="secondary body-small">
                      <time datetime=${quote.at}>${new Date(quote.at).toLocaleString()}</time>
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
