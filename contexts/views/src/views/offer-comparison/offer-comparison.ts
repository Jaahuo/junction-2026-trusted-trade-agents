import { html } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

/** Placeholder until the offer comparison issue. */
class OfferComparison extends ViewElement<ViewEntryOf<"offer-comparison">> {
  readonly entry = viewEntry("offer-comparison");

  protected override renderDone(data: ViewData<"offer-comparison">) {
    return html`<p part="done">
      ${data.offers.length} offers, ${data.omitted.length} products omitted
    </p>`;
  }
}

export const defineOfferComparison = () => defineView("tt-offer-comparison", OfferComparison);

declare global {
  interface HTMLElementTagNameMap {
    "tt-offer-comparison": OfferComparison;
  }
}
