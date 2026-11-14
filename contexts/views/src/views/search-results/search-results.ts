import { css, html, nothing, type TemplateResult } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";

export function renderSearchResults(data: ViewData<"search-results">): TemplateResult {
  return html`<section class="results" part="done">
    <h2>Search results</h2>
    <section class="constraints" aria-labelledby="constraints-heading">
      <h3 id="constraints-heading">Applied constraints</h3>
      <div class="constraint-group">
        <h4>Required</h4>
        ${
          data.constraints.hard.length === 0
            ? html`<p class="secondary">None</p>`
            : html`<ul>
                ${data.constraints.hard.map(() => html`<li>Lactose free</li>`)}
              </ul>`
        }
      </div>
      <div class="constraint-group">
        <h4>Preferred</h4>
        ${
          data.constraints.soft.length === 0
            ? html`<p class="secondary">None</p>`
            : html`<ul>
                ${data.constraints.soft.map(
                  (constraint) =>
                    html`<li>
                      ${
                        constraint.attribute === "countryOfOrigin"
                          ? "Country of origin"
                          : constraint.attribute
                      }:
                      ${constraint.prefer}
                    </li>`,
                )}
              </ul>`
        }
      </div>
    </section>
    <div class="candidates">
      ${data.candidates.map(
        (candidate) =>
          html`<article class="candidate">
            <h3>${candidate.name}</h3>
            <p class="secondary body-small">Product ID: ${candidate.productId}</p>
            <p class="quantity">
              ${
                candidate.orderQuantity === null
                  ? "Quantity unknown"
                  : html`Order quantity: ${candidate.orderQuantity.value}
                    ${candidate.orderQuantity.unit}`
              }
            </p>
            ${
              candidate.equals === null
                ? nothing
                : html`<p>Equals: ${candidate.equals.value} ${candidate.equals.unit}</p>`
            }
            <div class="matches">
              <h4>Constraint matches</h4>
              ${
                Object.entries(candidate.match).length === 0
                  ? html`<p class="secondary">No match information</p>`
                  : html`<ul>
                      ${Object.entries(candidate.match).map(
                        ([attribute, state]) =>
                          html`<li>
                            ${attribute === "lactose" ? "Lactose free" : attribute}:
                            <span class=${state}
                              >${
                                state === "confirmed"
                                  ? "Confirmed"
                                  : state === "unknown"
                                    ? "Unknown"
                                    : "Contradicted"
                              }</span
                            >
                          </li>`,
                      )}
                    </ul>`
              }
            </div>
          </article>`,
      )}
    </div>
  </section>`;
}

class SearchResults extends ViewElement<ViewEntryOf<"search-results">> {
  static override styles = [
    base,
    css`
      .results {
        display: grid;
        gap: var(--spacing-lg);
        min-width: 0;
        overflow-wrap: anywhere;
      }
      h2 {
        color: var(--color-heading);
        font-size: var(--font-size-xl);
        font-weight: 700;
      }
      h3 {
        font-weight: 700;
      }
      h4 {
        font-weight: 600;
      }
      .constraints,
      .candidate {
        min-width: 0;
        padding: var(--spacing-lg);
        border: 1px solid var(--color-border);
        border-radius: var(--border-radius-lg);
      }
      .constraints {
        background: var(--color-bg-brand-subtle);
      }
      .constraint-group,
      .quantity,
      .matches {
        margin-top: var(--spacing-md);
      }
      .candidates {
        display: grid;
        gap: var(--spacing-md);
        min-width: 0;
      }
      ul {
        padding-left: var(--spacing-xl);
      }
      .confirmed {
        color: var(--color-text-success);
      }
      .unknown {
        color: var(--color-text-warning);
      }
      .contradicted {
        color: var(--color-text-danger);
      }
    `,
  ];
  readonly entry = viewEntry("search-results");

  protected override renderDone(data: ViewData<"search-results">) {
    return renderSearchResults(data);
  }
}

export const defineSearchResults = () => defineView("tt-search-results", SearchResults);

declare global {
  interface HTMLElementTagNameMap {
    "tt-search-results": SearchResults;
  }
}
