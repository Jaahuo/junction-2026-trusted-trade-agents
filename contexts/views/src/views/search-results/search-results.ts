import { html } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

/** Placeholder until the search results issue. */
class SearchResults extends ViewElement<ViewEntryOf<"search-results">> {
  readonly entry = viewEntry("search-results");

  protected override renderDone(data: ViewData<"search-results">) {
    return html`<p part="done">
      ${data.candidates.map((candidate) => candidate.name).join(", ")}
    </p>`;
  }
}

export const defineSearchResults = () => defineView("tt-search-results", SearchResults);

declare global {
  interface HTMLElementTagNameMap {
    "tt-search-results": SearchResults;
  }
}
