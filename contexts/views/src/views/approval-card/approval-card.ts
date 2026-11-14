import { html, nothing } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

/** Placeholder until the approval card issue (#21): one line per order and its approval link. */
class ApprovalCard extends ViewElement<ViewEntryOf<"approval-card">> {
  readonly entry = viewEntry("approval-card");

  protected override renderDone(data: ViewData<"approval-card">) {
    const orders = "orders" in data ? data.orders : [data];
    return html`<ul part="done">
      ${orders.map(
        (order) =>
          html`<li>
            ${order.orderId}: ${order.status}
            ${
              order.approvalUrl === null
                ? nothing
                : html`<a href=${order.approvalUrl} target="_blank" rel="noreferrer"
                    >Approval page</a
                  >`
            }
          </li>`,
      )}
    </ul>`;
  }
}

export const defineApprovalCard = () => defineView("tt-approval-card", ApprovalCard);

declare global {
  interface HTMLElementTagNameMap {
    "tt-approval-card": ApprovalCard;
  }
}
