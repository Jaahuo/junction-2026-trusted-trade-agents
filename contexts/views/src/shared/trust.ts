import type { OrderLine } from "@app/contract";
import { css, html, nothing } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import alertCircle from "./icons/alert-circle.svg?raw";
import check16 from "./icons/check-16.svg?raw";
import checkCircle from "./icons/check-circle.svg?raw";
import clockCircle from "./icons/clock-circle.svg?raw";
import warning16 from "./icons/warning-16.svg?raw";
import xCircle from "./icons/x-circle.svg?raw";
import { pick } from "./locale.ts";

// Trust and rationale parts (#74): allergen chips, the signature seal and the status disc of
// the order log. Figma: Junction 2026 › Components › "Allergen chip", "Signature seal".

export type LineAllergen = NonNullable<OrderLine["allergens"]>[number];
export type Tone = "success" | "warning" | "danger";

const TEXT = {
  en: {
    relation: { free_from: "Free from", contains: "Contains", may_contain: "May contain" },
    brokenRule: (rule: string) => `Breaks your rule: ${rule}`,
    noAllergen: (allergen: string) => `no ${allergen}`,
  },
  fi: {
    relation: { free_from: "Ei sisällä", contains: "Sisältää", may_contain: "Voi sisältää" },
    brokenRule: (rule: string) => `Rikkoo sääntöäsi: ${rule}`,
    noAllergen: (allergen: string) => `ei ${allergen}`,
  },
};

/** "Contains egg": the chip's phrase. */
export const allergenText = (a: LineAllergen) => `${pick(TEXT).relation[a.type]} ${a.allergen}`;
/** "Breaks your rule: no egg": the action of a broken rule's to-do. */
export const brokenRule = (a: LineAllergen) => {
  const text = pick(TEXT);
  return text.brokenRule(a.rule ?? text.noAllergen(a.allergen));
};

/** Breaks a rule, then a trace risk, then meets a free-from rule, then information only. */
const rank = (a: LineAllergen) =>
  a.status === "error" ? 0 : a.status === "warning" ? 1 : a.type === "free_from" ? 2 : 3;

export const sortAllergens = (list: LineAllergen[]) =>
  list.toSorted((a, b) => rank(a) - rank(b) || a.allergen.localeCompare(b.allergen));

/** Colour and icon by the relation to the buyer's rules; information-only chips are plain. */
const chipLook = (a: LineAllergen): { tone: string; svg: string | null } => {
  if (a.status === "error") return { tone: "danger", svg: xCircle };
  if (a.status === "warning") return { tone: "warning", svg: warning16 };
  if (a.type === "free_from") return { tone: "success", svg: check16 };
  return { tone: "", svg: null };
};

const glyph = (svg: string) => html`<span class="icon" aria-hidden="true">${unsafeSVG(svg)}</span>`;

export const allergenChips = (list: LineAllergen[] | undefined) =>
  list === undefined || list.length === 0
    ? nothing
    : html`<ul class="allergens">
        ${sortAllergens(list).map((a) => {
          const { tone, svg } = chipLook(a);
          return html`<li class="allergen label-small ${tone}">
            ${svg === null ? nothing : glyph(svg)}${allergenText(a)}
          </li>`;
        })}
      </ul>`;

const DISC: Record<Tone, string> = { success: checkCircle, warning: clockCircle, danger: xCircle };

/** The 20 px status disc; `alert` swaps the warning clock for an exclamation mark. */
export const statusDisc = (tone: Tone, alert = false) =>
  html`<span class="disc ${tone}" aria-hidden="true"
    >${unsafeSVG(tone === "warning" && alert ? alertCircle : DISC[tone])}</span
  >`;

/** The signature seal: a tinted full-width box with a status disc, title and detail. */
export const seal = (tone: Tone, title: string, detail: string) =>
  html`<div class="seal ${tone}" part="seal" aria-live="polite">
    ${statusDisc(tone)}
    <div>
      <p class="strong">${title}</p>
      <p class="caption">${detail}</p>
    </div>
  </div>`;

export const trustStyles = css`
  .allergens {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0;
    list-style: none;
  }
  .allergen {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs);
    padding: 2px var(--spacing-sm);
    border-radius: 3px;
    background: var(--color-bg-subtle);
    color: var(--color-text);
  }
  .allergen .icon svg {
    width: 12px;
    height: 12px;
  }
  .allergen.success {
    background: var(--color-bg-success);
    color: var(--color-text-success);
  }
  .allergen.warning {
    background: var(--color-bg-warning);
    color: var(--color-text-warning);
  }
  .allergen.danger {
    background: var(--color-bg-danger);
    color: var(--color-text-danger);
  }
  .disc {
    display: inline-flex;
    flex-shrink: 0;
  }
  .disc svg {
    width: 20px;
    height: 20px;
  }
  .disc.warning {
    color: var(--color-text-warning);
  }
  .seal,
  .strip {
    display: flex;
    align-items: flex-start;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    border-radius: var(--border-radius-md);
    color: var(--color-text);
  }
  .seal.success,
  .strip.success {
    background: var(--color-bg-success);
  }
  .seal.warning,
  .strip.warning {
    background: var(--color-bg-warning);
  }
  .seal.danger,
  .strip.danger {
    background: var(--color-bg-danger);
  }
  .caption {
    font-size: var(--font-size-2xs);
    line-height: 1.3;
  }
`;
