import { html } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

/** Placeholder until the order timeline issue. */
class OrderTimeline extends ViewElement<ViewEntryOf<"order-timeline">> {
  readonly entry = viewEntry("order-timeline");

  protected override renderDone(order: ViewData<"order-timeline">) {
    return html`<p part="done">
      Order ${order.orderId} is ${order.status}, ${order.audit.length} events
    </p>`;
  }
}

export const defineOrderTimeline = () => defineView("tt-order-timeline", OrderTimeline);

declare global {
  interface HTMLElementTagNameMap {
    "tt-order-timeline": OrderTimeline;
  }
}
