import { html } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { pick } from "../../shared/locale.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { OFFERS } from "./strings.ts";

/** Placeholder until the offer comparison issue. */
class OfferComparison extends ViewElement<ViewEntryOf<"offer-comparison">> {
  readonly entry = viewEntry("offer-comparison");

  protected override renderDone(data: ViewData<"offer-comparison">) {
    return html`<p part="done">
      ${pick(OFFERS).summary(data.offers.length, data.omitted.length)}
    </p>`;
  }
}

export const defineOfferComparison = () => defineView("tt-offer-comparison", OfferComparison);

declare global {
  interface HTMLElementTagNameMap {
    "tt-offer-comparison": OfferComparison;
  }
}
