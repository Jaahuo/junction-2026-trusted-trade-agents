import { css, html, nothing, type TemplateResult } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { pick } from "../../shared/locale.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { RESULTS } from "./strings.ts";

export function renderSearchResults(data: ViewData<"search-results">): TemplateResult {
  const text = pick(RESULTS);
  return html`<section class="results" part="done">
    <h2>${text.title}</h2>
    <section class="constraints" aria-labelledby="constraints-heading">
      <h3 id="constraints-heading">${text.applied}</h3>
      <div class="constraint-group">
        <h4>${text.required}</h4>
        ${
          data.constraints.hard.length === 0
            ? html`<p class="secondary">${text.none}</p>`
            : html`<ul>
                ${data.constraints.hard.map(() => html`<li>${text.lactoseFree}</li>`)}
              </ul>`
        }
      </div>
      <div class="constraint-group">
        <h4>${text.preferred}</h4>
        ${
          data.constraints.soft.length === 0
            ? html`<p class="secondary">${text.none}</p>`
            : html`<ul>
                ${data.constraints.soft.map(
                  (constraint) =>
                    html`<li>
                      ${
                        constraint.attribute === "countryOfOrigin"
                          ? text.countryOfOrigin
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
            <p class="secondary body-small">${text.productId(candidate.productId)}</p>
            <p class="quantity">
              ${
                candidate.orderQuantity === null
                  ? text.quantityUnknown
                  : html`${text.orderQuantity} ${candidate.orderQuantity.value}
                    ${candidate.orderQuantity.unit}`
              }
            </p>
            ${
              candidate.equals === null
                ? nothing
                : html`<p>${text.equals} ${candidate.equals.value} ${candidate.equals.unit}</p>`
            }
            <div class="matches">
              <h4>${text.matches}</h4>
              ${
                Object.entries(candidate.match).length === 0
                  ? html`<p class="secondary">${text.noMatchInfo}</p>`
                  : html`<ul>
                      ${Object.entries(candidate.match).map(
                        ([attribute, state]) =>
                          html`<li>
                            ${attribute === "lactose" ? text.lactoseFree : attribute}:
                            <span class=${state}
                              >${
                                state === "confirmed"
                                  ? text.confirmed
                                  : state === "unknown"
                                    ? text.unknown
                                    : text.contradicted
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
