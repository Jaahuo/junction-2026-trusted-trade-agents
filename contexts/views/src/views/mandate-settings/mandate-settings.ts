import { html } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

/** Placeholder until the mandate settings issue. */
class MandateSettings extends ViewElement<ViewEntryOf<"mandate-settings">> {
  readonly entry = viewEntry("mandate-settings");

  protected override renderDone({ mandate, status }: ViewData<"mandate-settings">) {
    const limit = mandate.limits.maxOrderTotal;
    return html`<p part="done">
      Mandate ${mandate.mandateId} v${mandate.version} is ${status}, order limit ${limit.value}
      ${limit.currency}
    </p>`;
  }
}

export const defineMandateSettings = () => defineView("tt-mandate-settings", MandateSettings);

declare global {
  interface HTMLElementTagNameMap {
    "tt-mandate-settings": MandateSettings;
  }
}
