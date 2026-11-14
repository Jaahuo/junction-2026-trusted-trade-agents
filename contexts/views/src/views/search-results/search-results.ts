import type { MatchState, SearchCandidate } from "@app/contract";
import { brand } from "@app/ui/brand";
import { formatQuantity } from "@app/ui/format";
import { css, html, type TemplateResult } from "lit";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { intlLocale, lang, pick } from "../../shared/locale.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { brandHeader, cardStyles, rows } from "../approval-card/parts.ts";
import { RESULTS } from "./strings.ts";

/** "packagingMaterial", "invented_drinks" → "Packaging material", "Invented drinks". */
const words = (key: string) => {
  const spaced = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
/** "fi" → "Finland"; a code with no region name falls back to words. */
const country = (code: string) => {
  try {
    const regions = new Intl.DisplayNames([intlLocale()], { type: "region", fallback: "none" });
    return regions.of(code.toUpperCase()) ?? words(code);
  } catch {
    return words(code);
  }
};
const attributeName = (attribute: string) =>
  attribute === "countryOfOrigin" ? pick(RESULTS).countryOfOrigin : words(attribute);

// Every hard constraint is "free_from" (SPEC-004). Any attribute, so new allergens (#71) need no change.
type Results = Omit<ViewData<"search-results">, "constraints"> & {
  constraints: Omit<ViewData<"search-results">["constraints"], "hard"> & {
    hard: { attribute: string }[];
  };
};
const required = (attribute: string) =>
  attribute === "lactose" ? pick(RESULTS).lactoseFree : pick(RESULTS).free(words(attribute));
const preferred = (attribute: string, prefer: string) =>
  `${attributeName(attribute)}: ${attribute === "countryOfOrigin" ? country(prefer) : words(prefer)}`;
const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
/** Match keys are a hard attribute ("lactose") or "soft:<attribute>:<encoded value>" (SPEC-004). */
const matchLabel = (key: string) => {
  const [kind, attribute, value] = key.split(":");
  return kind === "soft" && attribute && value
    ? preferred(attribute, decode(value))
    : required(key);
};
const TONE: Record<MatchState, string> = {
  confirmed: "success",
  unknown: "warning",
  contradicted: "danger",
};

const frame = (part: string, title: string, body: TemplateResult) =>
  html`<article class="card" part=${part}>
    ${brandHeader(pick(RESULTS).eyebrow(brand.name), html`<h2 class="title">${title}</h2>`)}
    <div class="body">${body}</div>
  </article>`;

const candidateCard = (candidate: SearchCandidate) => {
  const text = pick(RESULTS);
  const l = lang();
  const order = candidate.orderQuantity;
  const percent = new Intl.NumberFormat(intlLocale(), {
    style: "percent",
    maximumFractionDigits: 1,
  });
  return html`<li class="candidate">
    <h3 class="strong">${candidate.name}</h3>
    ${
      Object.keys(candidate.match).length === 0
        ? html`<p class="secondary body-small">${text.noMatchInfo}</p>`
        : html`<ul class="matches">
            ${Object.entries(candidate.match).map(
              ([key, state]) =>
                html`<li class="pill ${TONE[state]}">${matchLabel(key)} · ${text[state]}</li>`,
            )}
          </ul>`
    }
    ${rows([
      [
        text.order,
        order === null
          ? `${text.quantityUnknown} ${candidate.quantityReason ?? text.noQuantityReason}`
          : formatQuantity(order, l),
      ],
      [
        text.equals,
        order === null || candidate.equals === null ? null : formatQuantity(candidate.equals, l),
      ],
      [
        text.reliability,
        candidate.deliveryReliability === null
          ? text.notKnown
          : text.reliabilityValue(percent.format(candidate.deliveryReliability)),
      ],
      [
        text.co2,
        candidate.co2PerKg === null
          ? text.notKnown
          : text.co2Value(formatQuantity({ value: candidate.co2PerKg, unit: "KGM" }, l)),
      ],
      [text.productId, candidate.productId],
    ])}
  </li>`;
};

export function renderSearchResults(data: Results): TemplateResult {
  const text = pick(RESULTS);
  const { hard, soft } = data.constraints;
  return frame(
    "done",
    text.found(data.candidates.length),
    html`<section class="constraints" aria-labelledby="constraints-heading">
        <h3 id="constraints-heading" class="label-small secondary">${text.applied}</h3>
        ${rows([
          [
            text.required,
            hard.length === 0 ? text.none : hard.map((c) => required(c.attribute)).join(", "),
          ],
          [
            text.preferred,
            soft.length === 0
              ? text.none
              : soft.map((c) => preferred(c.attribute, c.prefer)).join(", "),
          ],
        ])}
      </section>
      <ul class="candidates">
        ${data.candidates.map(candidateCard)}
      </ul>`,
  );
}

export const renderNoResults = () => {
  const text = pick(RESULTS);
  return frame(
    "empty",
    text.emptyTitle,
    html`<p class="strong">${text.emptyBody}</p>
      <p class="secondary">${text.emptyHint}</p>`,
  );
};

class SearchResults extends ViewElement<ViewEntryOf<"search-results">> {
  static override styles = [
    base,
    cardStyles,
    css`
      .body {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .constraints {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }
      ul {
        padding: 0;
        list-style: none;
      }
      .candidates,
      .candidate {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .candidate {
        gap: var(--spacing-sm);
        padding-block: var(--spacing-lg);
        border-top: 1px solid var(--color-border);
      }
      .matches {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
      }
    `,
  ];
  readonly entry = viewEntry("search-results");

  override render() {
    return this.state.kind === "empty" ? renderNoResults() : super.render();
  }

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
