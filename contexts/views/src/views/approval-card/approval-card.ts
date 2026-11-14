import {
  type DecideApprovalRequest,
  type OfferClaims,
  type Order,
  type ReasonCode,
} from "@app/contract";
import { brand } from "@app/ui/brand";
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import checkCircle from "../../shared/icons/check-circle.svg?raw";
import chevronDown from "../../shared/icons/chevron-down.svg?raw";
import clock16 from "../../shared/icons/clock-16.svg?raw";
import clockIcon from "../../shared/icons/clock.svg?raw";
import attention from "../../shared/icons/attention.svg?raw";
import agent16 from "../../shared/icons/agent-16.svg?raw";
import bin from "../../shared/icons/bin.svg?raw";
import bullet from "../../shared/icons/bullet.svg?raw";
import minus16 from "../../shared/icons/minus-16.svg?raw";
import plus16 from "../../shared/icons/plus-16.svg?raw";
import search from "../../shared/icons/search.svg?raw";
import warning16 from "../../shared/icons/warning-16.svg?raw";
import xCircle from "../../shared/icons/x-circle.svg?raw";
import { intlLocale, LocaleController, pick } from "../../shared/locale.ts";
import { base } from "../../shared/styles.ts";
import {
  allergenChips,
  allergenText,
  brokenRule,
  seal,
  sortAllergens,
  statusDisc,
  trustStyles,
} from "../../shared/trust.ts";
import { CARD } from "./card-strings.ts";
import { productImage } from "./images.ts";
import {
  amount,
  brandHeader,
  cardStyles,
  day,
  fact,
  icon,
  money,
  number,
  rows,
  stdUnits,
  timeOnly,
  unit,
  when,
} from "./parts.ts";

// Figma: Junction 2026 › Screens › "Approval request — v17 (reasons on to-dos)", with the
// v11–v16 style and its "LATEST CHANGES" notes: no edit mode, a stepper on every ready line,
// live totals, an Order total block for the limit, and a reject without a reason. Every approval
// is an order of products, in one column at any width. Fields the order does not carry
// (kitchen, on behalf of, the agent's reason for a substitute) are left out.

type Reason = { title: string; detail: string | null; tone: "warning" | "info" };

type Handling = "split" | "later" | "fewer";

/** One v17 to-do: where (a product or area, scrolled to on click), what happened, what to do. */
type Todo = { where: string; target: string; reason: string; action: string };

const warn = (title: string, detail: string | null = null): Reason => ({
  title,
  detail,
  tone: "warning",
});

/** Banner headline and short explanation per reason, from the v8 and v16 copy. */
function reasonCopy(code: ReasonCode, order: Order, claims: OfferClaims | undefined): Reason {
  const p = claims?.product;
  const text = pick(CARD);
  switch (code) {
    case "SPEND_OVER_LIMIT":
      return warn(text.overOrderLimit);
    case "NEW_PRODUCT":
      return {
        title: text.newProduct,
        detail: text.newProductDetail(order.customer),
        tone: "info",
      };
    case "SUBSTITUTION":
      return {
        title: text.substituteProposed,
        detail: text.substituteDetail,
        tone: "info",
      };
    case "CATEGORY_NOT_ALLOWED":
      return warn(
        text.categoryNotAllowed,
        p === undefined ? null : text.categoryDetail(p.category),
      );
    case "RELIABILITY_BELOW_MIN":
      return warn(
        text.reliabilityBelowMin,
        p?.deliveryReliability == null
          ? null
          : text.reliabilityDetail(Math.round(p.deliveryReliability * 100)),
      );
    case "CO2_ABOVE_MAX":
      return warn(
        text.co2AboveMax,
        p?.co2PerKg == null ? null : text.co2Detail(number(p.co2PerKg)),
      );
    case "UNCONFIRMED_ALLERGEN":
      return warn(text.allergenNotConfirmed);
    case "UNCONFIRMED_STOCK":
      return warn(text.stockNotConfirmed);
    case "QUANTITY_UNUSUAL":
      return warn(text.quantityUnusual);
    case "PAYMENT_TERMS":
      return warn(
        text.paymentTerms,
        order.paymentTerms === "pay_on_order" ? text.paymentTermsDetail : null,
      );
    default:
      return warn(text.reason[code]);
  }
}

const isApproved = (o: Order) => o.status === "placed" || o.status === "awaiting_payment";
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;
/** The lines a check names for `reason` in the audit (its `productId`). */
const linesFor = (order: Order, reason: ReasonCode) => {
  const ids = new Set(order.audit.filter((e) => e.reason === reason).map((e) => e.productId));
  return order.lines.map((l) => l.claims).filter((c) => ids.has(c.productId));
};
/**
 * A substitution on a line (Figma v17): the out-of-stock product, when known, and the products
 * proposed for it, recommended first. Either the line is the out-of-stock product and the
 * alternatives replace it, or the line is already the substitute (`replaces` set).
 */
type Substitution = { original: OfferClaims | undefined; options: OfferClaims[] };
const substitutionOf = (order: Order, c: OfferClaims): Substitution | null => {
  const lines = order.lines.map((l) => l.claims);
  const alternatives = order.alternatives.map((l) => l.claims);
  if (c.replaces !== null)
    return {
      original: lines.find((l) => l.productId === c.replaces),
      options: [c, ...alternatives],
    };
  if (lines.some((l) => l.replaces === c.productId)) return null;
  const proposed = alternatives.filter((a) => a.replaces === c.productId);
  return proposed.length === 0 ? null : { original: c, options: proposed };
};
/** A line that arrives after the requested date (`AVAILABILITY_DIFFERS`). */
const isLate = (c: OfferClaims) => c.deliveryDate > c.requestedDate;
const until = (c: OfferClaims) => (c.nextDeliveryDate === null ? null : day(c.nextDeliveryDate));
const outOfStock = (c: OfferClaims) => pick(CARD).outOfStock(until(c));
const names = (lines: OfferClaims[]) => lines.map((c) => c.product.name).join(", ");
/**
 * What needs a decision, one short line per reason, naming the product where there is one
 * ("Out of stock: …", "New product: …"), for the list of open orders.
 */
export function reasonSummaries(order: Order): string[] {
  const text = pick(CARD);
  const claims = order.lines.map((l) => l.claims);
  return order.reasons.flatMap((r) => {
    if (r === "SUBSTITUTION") {
      const replaced = claims.flatMap((c) => {
        const sub = substitutionOf(order, c);
        return sub === null ? [] : [sub.original ?? c];
      });
      return [text.outOfStockNamed(names(replaced))];
    }
    if (r === "AVAILABILITY_DIFFERS") {
      const short = claims.filter((c) => c.shortfall !== null);
      const late = claims.filter((c) => c.shortfall === null && isLate(c));
      const named = [
        ...(short.length === 0 ? [] : [text.notAllOnTime(names(short))]),
        ...(late.length === 0 ? [] : [text.arrivesLateNamed(names(late))]),
      ];
      if (named.length > 0) return named;
    }
    const title = reasonCopy(r, order, claims[0]).title;
    const named = linesFor(order, r);
    return [named.length === 0 ? title : `${title}: ${names(named)}`];
  });
}
/** The order line (with the agent's rationale and allergens) that carries these claims. */
const lineOf = (order: Order, c: OfferClaims) =>
  [...order.lines, ...order.alternatives].find((l) => l.offerId === c.offerId);
/** A ✦ line written by the agent. */
const agentLine = (text: string, extra = "") =>
  html`<p class="agent-line body-small ${extra}">${icon(agent16)}<span>${text}</span></p>`;
/** "Mon 16 Nov, 15:30". */
const dayTime = (at: string) =>
  new Intl.DateTimeFormat(intlLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
/** The element id of a product line, the target of its to-do. */
const lineId = (c: OfferClaims) => `line-${c.offerId}`;
/** A product's 48 px (or 40 px in a choice) image tile; nothing when it has no image. */
const thumb = (name: string, size: "line" | "small" = "line") => {
  const src = productImage(name);
  return src === null
    ? nothing
    : html`<span class="thumb ${size}"><img src=${src} alt="" /></span>`;
};
/** Products shown before "Show N more products". */
const SHOWN = 3;
const round = (value: number) => Math.round(value * 100) / 100;
/** "Wednesday", for the agent prompts. */
const weekday = (date: string) =>
  new Intl.DateTimeFormat(intlLocale(), { weekday: "long" }).format(new Date(date));
/** The number typed into a quantity field, or NaN. */
const typed = (e: Event) => (e.target instanceof HTMLInputElement ? Number(e.target.value) : NaN);

/**
 * One order for a human decision. Framework-agnostic: set `order`, `busy`, `canAsk` and
 * `orderLimit`, listen for `tt-decide` (detail: DecideApprovalRequest), `tt-confirm-changes`
 * (an edit to approve with its new quote), `tt-ask-agent` (detail: the message for the agent,
 * who then updates the order) and `tt-talk` (a message that starts a conversation). Restyle
 * through the tokens in shared/styles.ts or the `part` names.
 */
export class ApprovalCard extends LitElement {
  static override properties = {
    order: { attribute: false },
    busy: { type: Boolean },
    canAsk: { type: Boolean, attribute: "can-ask" },
    handling: { state: true },
    detailsOpen: { state: true },
    allProducts: { state: true },
    orderLimit: { attribute: false },
    error: { attribute: false },
    edits: { state: true },
    choicesOpen: { state: true },
    picked: { state: true },
    requoting: { state: true },
    rejecting: { state: true },
  };

  static override styles = [
    base,
    cardStyles,
    trustStyles,
    css`
      .section-title {
        color: var(--color-heading);
        font-family: var(--font-family-condensed);
        font-size: 20px;
        font-weight: 700;
        line-height: 1.1;
      }
      /* v17 "Needs your approval": one to-do per thing that needs the approver. */
      .todo {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
        background: var(--color-bg-attention);
      }
      .todo-title {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-family: var(--font-family-condensed);
        font-size: 20px;
        font-weight: 700;
        line-height: 1.1;
      }
      .todo-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: 0;
        list-style: none;
      }
      .todo-list li {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
      }
      .where {
        padding: 0;
        border: 0;
        background: none;
        color: var(--color-link);
        font: inherit;
        font-weight: 600;
        text-align: left;
        text-decoration: underline;
        cursor: pointer;
      }
      .product-list {
        margin-top: var(--spacing-sm);
        padding: 0;
        list-style: none;
      }
      .product {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-md) 0;
        border-bottom: 1px solid var(--color-border);
      }
      .product-top {
        display: flex;
        gap: var(--spacing-lg);
        font-weight: 600;
      }
      .product-name {
        flex: 1;
        min-width: 0;
        color: var(--color-heading);
      }
      .product-amounts {
        display: flex;
        gap: var(--spacing-lg);
      }
      .product-note {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding-top: var(--spacing-xs);
        color: var(--color-heading);
        font-size: var(--font-size-xs);
      }
      .product-note.warning {
        color: var(--color-text-warning);
      }
      .more-products {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md) 0;
        border: 0;
        background: none;
        color: var(--color-link);
        font: inherit;
        font-size: var(--font-size-xs);
        font-weight: 600;
        cursor: pointer;
      }
      .more-products[aria-expanded="true"] .icon {
        transform: rotate(180deg);
      }
      .link-button {
        padding: 0;
        border: 0;
        background: none;
        color: var(--color-link);
        font: inherit;
        font-size: var(--font-size-xs);
        font-weight: 600;
        cursor: pointer;
      }
      .product.flagged {
        gap: var(--spacing-md);
        margin: var(--spacing-md) 0;
        padding: var(--spacing-lg);
        border: 2px solid var(--color-border-brand);
      }
      .product.flagged > .link-button {
        align-self: flex-start;
      }
      .agent-help {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--spacing-sm);
      }
      .option-facts {
        display: flex;
        gap: var(--spacing-lg);
        margin-top: var(--spacing-xs);
      }
      .recommended {
        align-self: flex-start;
        padding: var(--spacing-2xs) var(--spacing-sm);
        border-radius: var(--radius-full);
        background: var(--color-bg-success);
        color: var(--color-text-success);
      }
      .choice {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-md) var(--spacing-lg);
        border-left: 4px solid transparent;
        cursor: pointer;
      }
      .choice.selected {
        border-left-color: var(--color-border-brand);
        background: var(--color-bg-brand-subtle);
      }
      .choice input {
        width: 18px;
        height: 18px;
        margin: 2px 0 0;
        accent-color: var(--color-border-brand);
      }
      .talk {
        align-self: flex-start;
      }
      .options {
        display: flex;
        flex-direction: column;
        align-items: stretch;
      }
      .options .more-products {
        align-self: flex-start;
      }
      .options .choice {
        border-bottom: 1px solid var(--color-border);
      }
      .choice-body {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: var(--spacing-xs);
      }
      .choice-top > :not(:first-child) {
        white-space: nowrap;
      }
      .choice-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--spacing-md);
      }
      /* Ready line row 2: quantity and pack stacked left; the pill stepper and bin right. */
      .amount-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-md);
      }
      .amount-row .product-amounts {
        flex-direction: column;
        gap: 0;
      }
      .controls {
        display: flex;
        align-items: center;
      }
      .stepper {
        display: flex;
        align-items: center;
        padding: var(--spacing-xs);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-full);
        background: var(--color-white);
      }
      .stepper button {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: var(--radius-full);
        background: var(--color-bg-brand-subtle);
        color: var(--color-text-brand);
        cursor: pointer;
      }
      /* A 40 px hit area around the 32 px circle. */
      .stepper button::after {
        position: absolute;
        inset: -4px;
        content: "";
      }
      .stepper button:disabled {
        color: var(--color-border-strong);
        cursor: not-allowed;
      }
      .stepper label {
        display: flex;
        align-items: baseline;
        gap: var(--spacing-xs);
        padding: 0 var(--spacing-xs);
        font-size: var(--font-size-xs);
      }
      .stepper input {
        width: 2.75rem;
        padding: 0;
        border: 0;
        background: none;
        color: var(--color-text);
        font: inherit;
        font-size: var(--font-size-sm);
        font-weight: 800;
        text-align: right;
        -moz-appearance: textfield;
      }
      .stepper input::-webkit-inner-spin-button {
        appearance: none;
      }
      .bin {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border: 0;
        border-radius: var(--radius-full);
        background: none;
        color: var(--color-text-secondary);
        cursor: pointer;
      }
      /* The new product tag above its name (Figma: success fill and text). */
      .tag {
        align-self: flex-start;
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--color-bg-success);
        color: var(--color-text-success);
        font-weight: 800;
      }
      fieldset.options {
        min-inline-size: 0;
        margin: 0;
        padding: 0;
        border: 0;
      }
      fieldset.options legend {
        margin-bottom: var(--spacing-sm);
        padding: 0;
      }
      .removed {
        display: flex;
        justify-content: space-between;
        padding: var(--spacing-md) 0;
      }
      /* The over-limit Order total block: total, limit and the difference, then agent help. */
      /* Over the limit: a 2 px petrol box (border inside, 16 px padding); within: 1 px grey. */
      /* A to-do link scrolls its target to the top, with a little room above it. */
      #order-total,
      #products,
      .product {
        scroll-margin-top: var(--spacing-lg);
      }
      .total-block {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        padding: var(--spacing-lg);
        border: 2px solid var(--color-border-brand);
      }
      .total-block.within {
        border: 1px solid var(--color-border);
      }
      /* Product lines: a 48 px image tile, then the text column. */
      .line-main {
        display: flex;
        gap: var(--spacing-md);
        align-items: flex-start;
      }
      .line-content {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: var(--spacing-xs);
        min-width: 0;
      }
      .thumb {
        flex-shrink: 0;
        width: 48px;
        height: 48px;
        overflow: hidden;
        border-radius: 6px;
      }
      .thumb.small {
        width: 40px;
        height: 40px;
      }
      .thumb img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transform: scale(1.5);
      }
      .limit-rows {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }
      .limit-rows div {
        display: flex;
        justify-content: space-between;
        gap: var(--spacing-md);
      }
      .limit-rows .limit {
        color: var(--color-text-secondary);
      }
      .limit-rows .difference {
        align-items: center;
        padding-top: var(--spacing-sm);
        border-top: 1px solid var(--color-border-strong);
        font-weight: 600;
      }
      .difference .label {
        display: flex;
        flex: 1;
        align-items: center;
        gap: var(--spacing-sm);
      }
      .difference.under .icon {
        color: var(--color-text-success);
      }
      .difference.over .icon {
        color: var(--color-text-warning);
      }
      /* The total row above the actions: same value as the header total. */
      .total-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding-top: var(--spacing-lg);
        border-top: 1px solid var(--color-border);
      }
      .total-row .value {
        font-family: var(--font-family-condensed);
        font-size: var(--font-size-xl);
        font-weight: 700;
      }
      .getting {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
      }

      .details-links {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-lg);
      }
      .open-until {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }
      .group {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }
      .group h3 {
        color: var(--color-heading);
      }
      .result {
        display: flex;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
        background: var(--color-bg-brand-subtle);
      }
      .result .title {
        color: var(--color-heading);
        font-weight: 600;
      }
      .result.success {
        background: var(--color-bg-success);
      }
      .result.success .title {
        color: var(--color-text-success);
      }
      .result.danger {
        background: var(--color-bg-danger);
      }
      .result.danger .title {
        color: var(--color-text-danger);
      }
      /* "Sending": the busy primary button stays solid; only the others fade. */
      .btn.primary[aria-busy="true"]:disabled {
        background: var(--color-button);
        color: var(--color-button-text);
        cursor: progress;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
      }
      .chips .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .details {
        border-top: 1px solid var(--color-border);
        background: var(--color-light-purple-aimo);
      }
      .toggle {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-lg) var(--spacing-xl);
        border: 0;
        background: none;
        font-family: inherit;
        text-align: left;
        cursor: pointer;
      }
      .toggle .more {
        color: var(--color-link);
        font-weight: 600;
      }
      .toggle .hint {
        flex: 1;
        text-align: right;
      }
      .toggle[aria-expanded="true"] .icon {
        transform: rotate(180deg);
      }
      .details-body {
        display: none;
        flex-direction: column;
        gap: var(--spacing-xl);
        padding: 0 var(--spacing-xl) var(--spacing-xl);
      }
      .details-body.open {
        display: flex;
      }
      /* #74: the agent's ✦ lines (purpose, per-line rationale) and a line's allergen chips. */
      .agent-line {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-xs);
      }
      .agent-line .icon {
        color: var(--color-text-brand);
      }
      .rationale {
        color: var(--color-text-secondary);
      }
      .line-trust {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        padding-top: var(--spacing-xs);
      }
      .result.sent {
        align-items: center;
        padding: 0;
        background: none;
      }
      .result.sent .disc svg {
        width: 24px;
        height: 24px;
      }
      .receipt .row dt {
        width: 140px;
      }
    `,
  ];

  declare order: Order | null;
  declare busy: boolean;
  /** True in a chat, where the agent help can message the agent. */
  declare canAsk: boolean;
  /** How to handle a shortfall (v16 options): split delivery, all later, or fewer. */
  declare private handling: Handling;
  declare private detailsOpen: boolean;
  declare private allProducts: boolean;
  /** The mandate's order limit (gross EUR), when the view could read it. */
  declare orderLimit: number | null;
  /** Why the last decision failed, shown above the buttons; null when it did not. */
  declare error: string | null;
  /** Changed quantities in sales units by offer id; 0 means removed. */
  declare private edits: Record<string, number>;
  declare private choicesOpen: boolean;
  /** The alternative's offer id picked under "Other choices"; null keeps the proposal. */
  declare private picked: string | null;
  /** True from Confirm with changed amounts until the new quote arrives. */
  declare private requoting: boolean;
  /** Re-renders the card in the new language when it changes. */
  protected readonly locale = new LocaleController(this);
  /** True from Reject until the decision comes back: Reject says "Rejecting…". */
  declare private rejecting: boolean;

  constructor() {
    super();
    this.order = null;
    this.busy = false;
    this.canAsk = false;
    this.handling = "split";
    this.detailsOpen = false;
    this.allProducts = false;
    this.orderLimit = null;
    this.error = null;
    this.edits = {};
    this.choicesOpen = false;
    this.picked = null;
    this.requoting = false;
    this.rejecting = false;
  }

  /** A new order (or a new version of it) starts without changes or picks. */
  override willUpdate(changed: PropertyValues<this>) {
    // A decision that came back without a new order failed: the buttons are ready again.
    if (changed.has("busy") && !this.busy) {
      this.requoting = false;
      this.rejecting = false;
    }
    if (changed.has("order")) {
      this.edits = {};
      this.picked = null;
      this.handling = "split";
      this.requoting = false;
      this.rejecting = false;
    }
  }

  /** After Confirm or Reject the result banner takes focus, so it is announced. */
  override updated(changed: PropertyValues<this>) {
    const before = changed.get("order");
    if (before?.status === "pending_approval" && this.order?.status !== "pending_approval")
      this.renderRoot.querySelector<HTMLElement>(".result")?.focus();
  }

  private decide(request: DecideApprovalRequest, type = "tt-decide") {
    this.dispatchEvent(new CustomEvent(type, { detail: request, bubbles: true, composed: true }));
  }

  private eyebrow(order: Order) {
    const text = pick(CARD);
    if (order.status === "placed") return text.approved;
    if (order.status === "awaiting_payment") return text.approvedWaiting;
    if (order.status !== "pending_approval") return text.rejected;
    if (this.busy && this.requoting) return text.gettingOffer;
    // Nothing left to approve after changing amounts (prototype A2): the logo only.
    return this.todos(order).length > 0 ? text.approvalRequired : "";
  }

  /** v16: an order of products, named by its delivery day, with order number and count. */
  private header(order: Order) {
    const text = pick(CARD);
    const earliest = order.lines.map((l) => l.claims.deliveryDate).toSorted()[0];
    const title = html`<div class="headline">
      <h2 class="name">${earliest === undefined ? text.order : text.orderFor(day(earliest))}</h2>
      <p aria-live="polite">${money(this.total(order, "net"))}</p>
    </div>`;
    const facts = html`<dl class="facts">
      ${fact(text.orderNo, order.orderId)} ${fact(text.products, String(order.lines.length))}
    </dl>`;
    const pill =
      order.status === "pending_approval" &&
      !(this.busy && this.requoting) &&
      this.todos(order).length > 0;
    return brandHeader(this.eyebrow(order), title, facts, pill);
  }

  /** v17 to-dos: one per thing the approver should look at, linked to where it is. */
  private todos(order: Order): Todo[] {
    const lines = order.lines.map((l) => l.claims);
    return [...this.allergenTodos(order), ...this.reasonTodos(order, lines)];
  }

  /** A broken hard rule or a trace risk against one, per line still in the order (#74). */
  private allergenTodos(order: Order): Todo[] {
    const text = pick(CARD);
    return order.lines.flatMap(({ claims: c, allergens = [] }) =>
      this.quantity(c) === 0
        ? []
        : sortAllergens(allergens)
            .filter((a) => a.status !== "default")
            .map((a) => ({
              where: c.product.name,
              target: lineId(c),
              reason: allergenText(a),
              action: a.status === "error" ? brokenRule(a) : text.checkAllergenRule(a.allergen),
            })),
    );
  }

  private reasonTodos(order: Order, lines: OfferClaims[]): Todo[] {
    const text = pick(CARD);
    return order.reasons.flatMap((r): Todo[] => {
      // A check the audit names products for gets one to-do per product still in the order.
      const productTodos = (reason: ReasonCode, why: string): Todo[] => {
        const named = linesFor(order, reason);
        if (named.length === 0) return [generic];
        return named
          .filter((c) => this.quantity(c) > 0)
          .map((c) => ({
            where: c.product.name,
            target: lineId(c),
            reason: why,
            action: text.checkYouWantProduct,
          }));
      };
      const generic: Todo = {
        where: reasonCopy(r, order, lines[0]).title,
        target: "products",
        reason: text.reason[r],
        action: text.checkProducts,
      };
      switch (r) {
        case "SPEND_OVER_LIMIT": {
          // Gone once the changed amounts bring the order under the limit.
          const over = this.overLimit(order);
          if (over !== null && over <= 0) return [];
          return [
            {
              where: text.orderTotal,
              target: "order-total",
              reason: text.totalOverLimit,
              action: over === null ? text.approveOrReject : text.reduceBy(money(round(over))),
            },
          ];
        }
        case "SUBSTITUTION":
          return lines.flatMap((c) => {
            const sub = substitutionOf(order, c);
            const head = sub?.original ?? c;
            return sub === null
              ? []
              : [
                  {
                    where: head.product.name,
                    target: lineId(c),
                    reason: text.outOfStockTitle(until(head)),
                    action: text.chooseReplacement,
                  },
                ];
          });
        case "NEW_PRODUCT":
          return productTodos(r, text.newNotOrdered);
        case "UNCONFIRMED_STOCK": {
          const c = lines.find((l) => l.stock === "unconfirmed");
          return [
            {
              where: c?.product.name ?? text.stock,
              target: c === undefined ? "products" : lineId(c),
              reason: text.stockIsNotConfirmed,
              action: text.checkAmount,
            },
          ];
        }
        case "AVAILABILITY_DIFFERS": {
          // One to-do per case: a line can be both short and late.
          const todos: Todo[] = [];
          for (const c of lines) {
            if (this.quantity(c) === 0) continue;
            const where = c.product.name;
            const target = lineId(c);
            if (c.shortfall !== null)
              todos.push({
                where,
                target,
                reason: text.shortForDelivery(amount(c.shortfall)),
                action: text.chooseHowToHandle,
              });
            if (isLate(c))
              todos.push({
                where,
                target,
                reason: text.arrivesOn(day(c.deliveryDate), day(c.requestedDate)),
                action: text.approveOrRemove,
              });
          }
          return todos.length === 0 ? [generic] : todos;
        }
        default:
          return productTodos(r, reasonCopy(r, order, lines[0]).title);
      }
    });
  }

  /** Scrolls to a to-do's product or section, showing hidden products first, and focuses it. */
  private async goTo(order: Order, target: string) {
    const index = order.lines.findIndex((l) => `line-${l.offerId}` === target);
    if (index >= SHOWN) this.allProducts = true;
    await this.updateComplete;
    const element = this.renderRoot.querySelector<HTMLElement>(`#${CSS.escape(target)}`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
    element?.focus({ preventScroll: true });
  }

  private todoBox(order: Order) {
    const items = this.todos(order);
    if (items.length === 0) return nothing;
    return html`<section class="todo" part="reason" aria-labelledby="todo-title">
      <h3 id="todo-title" class="todo-title">${icon(attention)}${pick(CARD).needsYourApproval}</h3>
      <ul class="todo-list">
        ${items.map(
          (t) =>
            html`<li>
              ${icon(bullet)}
              <div>
                <button
                  class="where"
                  aria-label="${t.where}, ${t.action.toLowerCase()}"
                  @click=${() => this.goTo(order, t.target)}
                >
                  ${t.where}
                </button>
                <p>${t.reason}</p>
                <p>${t.action}</p>
              </div>
            </li>`,
        )}
      </ul>
    </section>`;
  }

  /**
   * v17 agent help: the ready prompt and each chip go straight to the chat as a message about
   * `subject`. Only in a chat (`canAsk`).
   */
  private agentHelp(label: string, prompt: string, chips: string[]) {
    if (!this.canAsk) return nothing;
    return html`<div class="agent-help" part="agent-help">
      <button type="button" class="btn secondary" @click=${() => this.ask(prompt)}>
        ${icon(agent16)}${label}
      </button>
      ${
        chips.length === 0
          ? nothing
          : html`<p class="label-small secondary">${pick(CARD).orTellIt}</p>
              <div class="chips">
                ${chips.map(
                  (chip) =>
                    html`<button
                      type="button"
                      class="chip"
                      @click=${() => this.ask(`${prompt} ${chip}.`)}
                    >
                      ${icon(agent16)}${chip}
                    </button>`,
                )}
              </div>`
      }
    </div>`;
  }

  /** Sends a message to the agent; `tt-ask-agent` collapses the card while the agent works. */
  private ask(text: string, type = "tt-ask-agent") {
    this.dispatchEvent(new CustomEvent(type, { detail: text, bubbles: true, composed: true }));
  }

  /** How far the order (at the changed amounts) is over the limit, gross; null without one. */
  private overLimit(order: Order) {
    return this.orderLimit === null ? null : this.total(order, "gross") - this.orderLimit;
  }

  /**
   * The over-limit Order total block (target of the "Order total" to-do): total, limit and the
   * difference, live as amounts change, then agent help. The limit is on gross totals.
   */
  private totalBlock(order: Order) {
    if (!order.reasons.includes("SPEND_OVER_LIMIT")) return nothing;
    const text = pick(CARD);
    const over = this.overLimit(order);
    const limitRows =
      this.orderLimit === null || over === null
        ? nothing
        : html`<div class="limit">
              <dt>${text.yourOrderLimit}</dt>
              <dd>${money(this.orderLimit)}</dd>
            </div>
            <div class="difference ${over > 0 ? "over" : "under"}">
              <dt class="label">
                ${icon(over > 0 ? warning16 : checkCircle)}${over > 0 ? text.overYourLimit : text.underYourLimit}
              </dt>
              <dd>${over > 0 ? signed(round(over)) : money(round(-over))}</dd>
            </div>`;
    const within = over !== null && over <= 0;
    return html`<section class="group" id="order-total" tabindex="-1" part="order-total">
      <h3 class="section-title">${text.orderTotal}</h3>
      <div class="total-block ${within ? "within" : ""}">
        <dl class="limit-rows body-small" aria-live="polite">
          <div>
            <dt>${text.totalInclVat}</dt>
            <dd>${money(round(this.total(order, "gross")))}</dd>
          </div>
          ${limitRows}
        </dl>
        ${
          within
            ? nothing
            : this.agentHelp(
                text.letAgentReduce,
                text.reducePrompt(order.orderId),
                text.reduceChips,
              )
        }
      </div>
    </section>`;
  }

  /** The decision block of a flagged product: its choices and agent help (v17). */
  private lineDecision(order: Order, c: OfferClaims) {
    const text = pick(CARD);
    const sub = substitutionOf(order, c);
    if (sub !== null) {
      const head = sub.original ?? c;
      return html`${this.choices(sub)}
      ${this.agentHelp(text.letAgentFind, text.findPrompt(head.product.name, outOfStock(head)), [
        text.sameBrand,
        text.cheapest,
        ...(head.nextDeliveryDate === null ? [] : [text.waitUntil(day(head.nextDeliveryDate))]),
      ])}`;
    }
    if (c.shortfall === null) return isLate(c) ? this.lateDecision(c) : nothing;
    const pack = c.product.perSalesUnit;
    const later = c.nextDeliveryDate;
    const packs = (q: number) => (pack === null ? amount(c.quantity) : text.packs(number(q)));
    const missing = pack === null ? c.shortfall.value : Math.round(c.shortfall.value / pack.value);
    const perPack = c.total.net / c.quantity.value;
    const options: { value: Handling; label: string; facts: [string, string][]; price: string }[] =
      later === null
        ? []
        : [
            {
              value: "split",
              label: text.splitDelivery,
              facts: [
                [day(c.deliveryDate), packs(c.quantity.value)],
                [day(later), packs(missing)],
              ],
              price: money(0),
            },
            {
              value: "later",
              label: text.allOn(day(later)),
              facts: [[day(later), packs(c.quantity.value + missing)]],
              price: money(0),
            },
          ];
    options.push({
      value: "fewer",
      label: text.orderFewer,
      facts: [[day(c.deliveryDate), text.only(packs(c.quantity.value))]],
      price: signed(-round(perPack * missing)),
    });
    const [first, ...rest] = options;
    const open = this.choicesOpen;
    const option = (o: (typeof options)[number]) =>
      html`<label class="choice ${this.handling === o.value ? "selected" : ""}">
        <input
          type="radio"
          name="handling"
          .checked=${this.handling === o.value}
          @change=${() => (this.handling = o.value)}
        />
        <span class="choice-body">
          ${o === first ? html`<span class="recommended label-small">${text.recommended}</span>` : nothing}
          <span class="choice-top">
            <span>${o.label}</span>
            <span class="strong">${o.price}</span>
          </span>
          <dl class="option-facts body-small">
            ${o.facts.map(
              ([label, value]) =>
                html`<div>
                  <dt class="label-small secondary">${label}</dt>
                  <dd>${value}</dd>
                </div>`,
            )}
          </dl>
        </span>
      </label>`;
    const all = c.quantity.value + missing;
    return html`<fieldset class="options">
        <legend class="section-title">${text.howToHandle(amount(c.shortfall))}</legend>
        ${first === undefined ? nothing : option(first)}
        ${
          rest.length === 0
            ? nothing
            : html`<button
                type="button"
                class="more-products"
                aria-expanded=${open ? "true" : "false"}
                @click=${() => (this.choicesOpen = !open)}
              >
                ${open ? text.hideOtherChoices : text.otherChoices(rest.length)}${icon(chevronDown)}
              </button>`
        }
        ${open ? rest.map(option) : nothing}
      </fieldset>
      ${this.agentHelp(
        text.letAgentSort,
        text.shortPrompt(c.quantity.value, all, c.product.name, weekday(c.deliveryDate)),
        [
          ...(later === null ? [] : [text.allOnWeekday(weekday(later))]),
          text.onlyPacks(packs(c.quantity.value)),
          text.anotherProduct,
        ],
      )}`;
  }

  /** A late line: approving accepts its date; or remove it, or ask the agent for one on time. */
  private lateDecision(c: OfferClaims) {
    const text = pick(CARD);
    const name = c.product.name;
    return html`<p class="body-small">
        ${text.arrivesOn(day(c.deliveryDate), day(c.requestedDate))}
      </p>
      <button
        type="button"
        class="link-button"
        aria-label=${text.remove(name)}
        @click=${() => this.setQuantity(c, 0)}
      >
        ${text.removeProduct}
      </button>
      ${this.agentHelp(
        text.letAgentFindOnTime,
        text.latePrompt(name, day(c.requestedDate), day(c.deliveryDate)),
        [text.sameBrand, text.cheapest],
      )}`;
  }

  /**
   * The primary decision: approve, the picked alternative (`pick_alternative`), or a shortfall
   * handled by an edit (all on the later date, or only what arrives now).
   */
  private approveRequest(order: Order): DecideApprovalRequest {
    const proposalVersion = order.proposalVersion;
    if (this.picked !== null)
      return { decision: "pick_alternative", offerId: this.picked, proposalVersion };
    // A recommended substitute that is not in the order yet is picked like any other choice.
    const recommended = order.lines
      .map((l) => substitutionOf(order, l.claims)?.options[0])
      .find((o) => o !== undefined && o.replaces !== null && !order.offerIds.includes(o.offerId));
    if (recommended !== undefined)
      return { decision: "pick_alternative", offerId: recommended.offerId, proposalVersion };
    const c = order.lines.map((l) => l.claims).find((l) => l.shortfall !== null);
    if (c === undefined || c.shortfall === null || this.handling === "split")
      return { decision: "approve", proposalVersion };
    const pack = c.product.perSalesUnit;
    const missing = pack === null ? c.shortfall.value : Math.round(c.shortfall.value / pack.value);
    const later = this.handling === "later" && c.nextDeliveryDate !== null;
    return {
      decision: "edit",
      proposalVersion,
      changes: [
        {
          productId: c.productId,
          quantity: { ...c.quantity, value: c.quantity.value + (later ? missing : 0) },
          ...(later && c.nextDeliveryDate !== null ? { deliverBy: c.nextDeliveryDate } : {}),
        },
      ],
    };
  }

  private productLine(order: Order, c: OfferClaims, flagged: boolean) {
    // Ready lines (and a new product) of a pending order take a stepper and a bin (no edit mode).
    const text = pick(CARD);
    const editable = !flagged && order.status === "pending_approval";
    const isNew = editable && linesFor(order, "NEW_PRODUCT").includes(c);
    // A flagged substitute heads its box with the product it replaces (when the order has it)
    // and shows itself as the recommended "Replace with" option.
    const head = flagged && c.replaces !== null ? substitutionOf(order, c)?.original : c;
    const pack = head?.product.perSalesUnit ?? null;
    const q = head === undefined ? 0 : this.quantity(head);
    const amounts =
      head === undefined
        ? nothing
        : html`<p class="product-amounts body-small">
            <span>${amount(stdUnits({ ...head, quantity: { ...head.quantity, value: q } }))}</span>
            ${
              pack === null
                ? nothing
                : html`<span class="secondary">${number(q)} × ${amount(pack)}</span>`
            }
          </p>`;
    const summary =
      head === undefined
        ? nothing
        : html`<div class="line-main">
            ${thumb(head.product.name)}
            <div class="line-content">
              ${isNew ? html`<span class="tag label-small">${text.newProduct}</span>` : nothing}
              <p class="product-top">
                <span class="product-name">${head.product.name}</span
                ><span>${money(this.lineTotal(head))}</span>
              </p>
              ${
                editable
                  ? html`<div class="amount-row">
                      ${amounts}
                      <div class="controls">
                        ${this.stepper(head, q)}
                        <button
                          type="button"
                          class="bin"
                          aria-label=${text.remove(head.product.name)}
                          @click=${() => this.setQuantity(head, 0)}
                        >
                          ${icon(bin)}
                        </button>
                      </div>
                    </div>`
                  : amounts
              }
              ${this.lineTrust(order, head)}
            </div>
          </div>`;
    return html`<li
      class="product ${flagged ? "flagged" : ""}"
      id="line-${c.offerId}"
      tabindex="-1"
    >
      ${summary} ${flagged ? this.lineDecision(order, c) : nothing}
    </li>`;
  }

  /** The agent's reason for a product and its allergen chips (#74). */
  private lineTrust(order: Order, c: OfferClaims) {
    const line = lineOf(order, c);
    const rationale = line?.rationale;
    const allergens = line?.allergens ?? [];
    if (rationale === undefined && allergens.length === 0) return nothing;
    return html`<div class="line-trust">
      ${rationale === undefined ? nothing : agentLine(rationale, "rationale")}
      ${allergenChips(allergens)}
    </div>`;
  }

  /** v17 products: flagged lines first and always shown; ready lines collapse after three. */
  private products(order: Order) {
    const text = pick(CARD);
    const pending = order.status === "pending_approval";
    const all = order.lines.map((l) => l.claims);
    const news = linesFor(order, "NEW_PRODUCT");
    const isFlagged = (c: OfferClaims) =>
      pending && (substitutionOf(order, c) !== null || c.shortfall !== null || isLate(c));
    // A replaced product is shown at the top of its substitute's box, not as its own line.
    const replaced = new Set(all.map((c) => (isFlagged(c) ? c.replaces : null)));
    const kept = (c: OfferClaims) => this.quantity(c) > 0;
    const flagged = all.filter((c) => isFlagged(c) && kept(c));
    // A line against an allergen rule, then a new product, leads the ready lines (MVP: a
    // normal line with a tag), so neither hides behind "Show N more".
    const lead = (c: OfferClaims) =>
      (lineOf(order, c)?.allergens?.some((a) => a.status !== "default") ? 2 : 0) +
      Number(news.includes(c));
    const ready = all
      .filter((c) => !isFlagged(c) && !replaced.has(c.productId) && kept(c))
      .toSorted((a, b) => lead(b) - lead(a));
    const removed = all.filter((c) => !kept(c));
    const visible = this.allProducts ? ready : ready.slice(0, SHOWN);
    const hidden = ready.length - SHOWN;
    return html`<section part="products" id="products" tabindex="-1">
      <h3 class="section-title">${text.products}</h3>
      <ul class="product-list">
        ${flagged.map((c) => this.productLine(order, c, true))}
        ${visible.map((c) => this.productLine(order, c, false))}
      </ul>
      ${
        hidden > 0
          ? html`<button
              class="more-products"
              aria-expanded=${this.allProducts ? "true" : "false"}
              @click=${() => (this.allProducts = !this.allProducts)}
            >
              ${
                this.allProducts ? text.showFewerProducts : text.showMoreProducts(hidden)
              }${icon(chevronDown)}
            </button>`
          : nothing
      }
      ${removed.map(
        (c) =>
          html`<p class="removed body-small">
            <span>${text.removed(c.product.name)}</span>
            <button
              type="button"
              class="link-button"
              @click=${() => this.setQuantity(c, c.quantity.value)}
            >
              ${text.undo}
            </button>
          </p>`,
      )}
    </section>`;
  }

  /** The primary label, and while sending its busy form ("Confirming…", prototype P6). */
  private approveLabel(order: Order) {
    // "Approve order" while the order is over the limit; else "Confirm order".
    const over = this.overLimit(order);
    const confirm = !order.reasons.includes("SPEND_OVER_LIMIT") || (over !== null && over <= 0);
    const text = pick(CARD);
    if (this.busy && !this.requoting && !this.rejecting)
      return confirm ? text.confirming : text.approving;
    return confirm ? text.confirmOrder : text.approveOrder;
  }

  private pendingBody(order: Order) {
    const text = pick(CARD);
    const changed = this.changed(order);
    const gettingOffer =
      this.busy && this.requoting
        ? html`<p class="getting strong" role="status">${text.gettingOfferAndOrdering}</p>`
        : nothing;
    const confirm = () => {
      if (!changed) return this.decide(this.approveRequest(order));
      this.requoting = true;
      this.decide(
        { decision: "edit", proposalVersion: order.proposalVersion, changes: this.changes(order) },
        "tt-confirm-changes",
      );
    };
    const purpose =
      order.purpose === undefined || order.purpose === ""
        ? nothing
        : html`<section class="group" part="purpose">
            <h3 class="section-title">${text.purpose}</h3>
            ${agentLine(order.purpose)}
          </section>`;
    return html`${gettingOffer} ${purpose} ${this.todoBox(order)} ${this.totalBlock(order)}
      ${this.products(order)}
      ${changed ? html`<p class="body-small">${text.changedAmounts}</p>` : nothing}
      <p class="total-row">
        <span>${text.orderTotal}</span
        ><span class="value" aria-live="polite">${money(this.total(order, "net"))}</span>
      </p>
      ${
        this.error === null
          ? nothing
          : html`<p class="message danger" role="alert" part="decision-error">${this.error}</p>`
      }
      <div class="actions" part="actions">
        <button
          part="button approve"
          class="btn primary"
          aria-busy=${this.busy && !this.rejecting ? "true" : "false"}
          @click=${() => (this.busy ? undefined : confirm())}
        >
          ${this.approveLabel(order)}
        </button>
        <button
          part="button reject"
          class="btn brand"
          aria-busy=${this.busy && this.rejecting ? "true" : "false"}
          @click=${() => {
            if (this.busy) return;
            // Just reject: no reason form yet, and the agent does not try again.
            this.rejecting = true;
            this.decide({
              decision: "reject",
              next: "stop",
              proposalVersion: order.proposalVersion,
            });
          }}
        >
          ${this.busy && this.rejecting ? text.rejecting : text.reject}
        </button>
      </div>
      ${
        this.canAsk
          ? html`<button
              type="button"
              class="btn secondary talk"
              part="button talk"
              @click=${() => this.ask(text.aboutOrder(order.orderId), "tt-talk")}
            >
              ${icon(agent16)}${text.discussWithAgent}
            </button>`
          : nothing
      }`;
  }

  /** "Replace with": the recommended product, and "Other choices (N)" for the rest (Figma v17). */
  private choices({ original, options }: Substitution) {
    const [recommended, ...others] = options;
    if (recommended === undefined) return nothing;
    const reference = original ?? recommended;
    const open = this.choicesOpen;
    const text = pick(CARD);
    return html`<fieldset class="options">
      <legend class="section-title">${text.replaceWith}</legend>
      ${this.choice(recommended, true, reference)}
      ${
        others.length === 0
          ? nothing
          : html`<button
              type="button"
              class="more-products"
              aria-expanded=${open ? "true" : "false"}
              @click=${() => (this.choicesOpen = !open)}
            >
              ${open ? text.hideOtherChoices : text.otherChoices(others.length)}${icon(chevronDown)}
            </button>`
      }
      ${open ? others.map((c) => this.choice(c, false, reference)) : nothing}
    </fieldset>`;
  }

  /** One product to choose, with its difference to the out-of-stock product (or the total). */
  private choice(c: OfferClaims, recommended: boolean, reference: OfferClaims) {
    const selected = this.picked === (recommended ? null : c.offerId);
    const std = stdUnits(c);
    const pack = c.product.perSalesUnit;
    const text = pick(CARD);
    return html`<label class="choice ${selected ? "selected" : ""}">
      <input
        type="radio"
        name="product-choice"
        .checked=${selected}
        @change=${() => (this.picked = recommended ? null : c.offerId)}
      />
      ${thumb(c.product.name, "small")}
      <span class="choice-body">
        ${recommended ? html`<span class="recommended label-small">${text.recommended}</span>` : nothing}
        <span class="choice-top">
          <span>${c.product.name}</span>
          <span class="strong"
            >${c === reference ? money(c.total.net) : signed(c.total.net - reference.total.net)}</span
          >
        </span>
        <dl class="option-facts body-small">
          <div>
            <dt class="label-small secondary">${text.pack}</dt>
            <dd>
              ${pack === null ? amount(c.quantity) : `${number(c.quantity.value)} × ${amount(pack)}`}
            </dd>
          </div>
          <div>
            <dt class="label-small secondary">${text.price}</dt>
            <dd>${money(round(c.total.net / std.value))} / ${unit(std.unit)}</dd>
          </div>
        </dl>
      </span>
    </label>`;
  }

  /** A line's quantity in sales units after the edits; 0 when removed. */
  private quantity(c: OfferClaims) {
    return this.edits[c.offerId] ?? c.quantity.value;
  }

  private setQuantity(c: OfferClaims, value: number) {
    if (Number.isFinite(value))
      this.edits = { ...this.edits, [c.offerId]: Math.max(0, Math.round(value)) };
  }

  /** A line's total at its changed amount; the new quote sets the exact price. */
  private lineTotal(c: OfferClaims, basis: "net" | "gross" = "net") {
    const q = this.quantity(c);
    return q === c.quantity.value
      ? c.total[basis]
      : Math.round((c.total[basis] / c.quantity.value) * q);
  }

  /** The order total at the changed amounts; the order's own total when nothing changed. */
  private total(order: Order, basis: "net" | "gross") {
    if (!this.changed(order)) return order.total[basis];
    return Math.round(order.lines.reduce((sum, l) => sum + this.lineTotal(l.claims, basis), 0));
  }

  private changed(order: Order) {
    return order.lines.some((l) => this.quantity(l.claims) !== l.claims.quantity.value);
  }

  /** The `edit` changes: a new quantity per changed line, 0 for a removed one. */
  private changes(order: Order) {
    return order.lines
      .map((l) => l.claims)
      .filter((c) => this.quantity(c) !== c.quantity.value)
      .map((c) => ({
        productId: c.productId,
        quantity: { value: this.quantity(c), unit: c.quantity.unit },
      }));
  }

  /** The − amount + stepper of a ready line; the amount can also be typed. */
  private stepper(c: OfferClaims, q: number) {
    const name = c.product.name;
    const text = pick(CARD);
    return html`<div class="stepper">
      <button
        type="button"
        aria-label=${text.decrease(name)}
        ?disabled=${q <= 1}
        @click=${() => this.setQuantity(c, q - 1)}
      >
        ${icon(minus16)}
      </button>
      <label
        ><input
          type="number"
          min="1"
          inputmode="numeric"
          aria-label="${name}, ${unit(c.quantity.unit)}"
          .value=${String(q)}
          @change=${(e: Event) => this.setQuantity(c, Math.max(1, typed(e)))}
        />${unit(c.quantity.unit)}</label
      >
      <button
        type="button"
        aria-label=${text.increase(name)}
        @click=${() => this.setQuantity(c, q + 1)}
      >
        ${icon(plus16)}
      </button>
    </div>`;
  }

  private decidedBody(order: Order) {
    const text = pick(CARD);
    const decision = order.decision;
    const by =
      decision === null
        ? null
        : `${decision.by === "approver" ? text.you : decision.by}, ${when(new Date(decision.at)).replace(text.todayStart, text.todayMid)}`;
    const earliest = order.lines.map((l) => l.claims.deliveryDate).toSorted()[0];
    if (order.status === "placed") return this.receipt(order, earliest);
    const result =
      order.status === "awaiting_payment"
        ? {
            tone: "",
            svg: clockIcon,
            title: text.waitingTitle,
            text: text.waitingText,
          }
        : decision?.next === "alternatives"
          ? {
              tone: "",
              svg: search,
              title: text.alternativesTitle,
              text: text.alternativesText,
            }
          : decision?.next === "stop"
            ? {
                tone: "",
                svg: xCircle,
                title: text.stopTitle,
                text: text.stopText,
              }
            : {
                tone: "danger",
                svg: xCircle,
                title: text.rejected,
                text: order.reasons.map((r) => text.reason[r]).join(" "),
              };
    const note = decision?.note ?? "";
    return html`<div class="result ${result.tone}" part="result" role="status" tabindex="-1">
        ${icon(result.svg)}
        <div>
          <p class="title">${result.title}</p>
          <p class="body-small">${result.text}</p>
        </div>
      </div>
      ${
        isApproved(order)
          ? html`${rows([
              [text.approvedBy, by],
              [text.payment, text.prepayment],
            ])}
            ${this.changeUntil(order)} ${this.products(order)}`
          : decision?.next === "stop"
            ? nothing
            : rows([[text.yourNote, note === "" ? null : `“${note}”`]])
      }`;
  }

  /**
   * P7/A6 signed receipt: "Order sent", the order rows, the wholesaler's signature on the
   * confirmation when the order has one, and the link to the order log.
   */
  private receipt(order: Order, earliest: string | undefined) {
    const text = pick(CARD);
    const decision = order.decision;
    const log = logUrl(order);
    return html`<div class="result sent" part="result" role="status" tabindex="-1">
        ${statusDisc("success")}
        <h3 class="section-title">${text.orderSent}</h3>
      </div>
      <div class="receipt">
        ${rows([
          [text.orderNo, order.orderId],
          [text.delivery, earliest === undefined ? null : day(earliest)],
          [text.total, text.exclVat(money(order.total.net))],
          [
            text.confirmedBy,
            decision === null ? null : text.youAt(timeOnly(new Date(decision.at))),
          ],
        ])}
      </div>
      ${this.receiptSeal(order)}
      ${log === null ? nothing : html`<a class="body-small" href=${log} target="_blank" rel="noreferrer">${text.viewOrderLog}</a>`}
      ${this.changeUntil(order)} ${this.products(order)}`;
  }

  private receiptSeal(order: Order) {
    const text = pick(CARD);
    const signature = order.receiptSignature;
    if (signature === undefined) return nothing;
    if (signature.state === "verified") {
      const at = signature.signedAt === null ? null : timeOnly(new Date(signature.signedAt));
      return seal(
        "success",
        text.receiptSigned(brand.name),
        text.receiptSignedText(brand.name, order.orderId, at),
      );
    }
    if (signature.state === "pending")
      return seal("warning", text.receiptPending, text.receiptPendingText(brand.name));
    return seal("danger", text.receiptMismatch, text.receiptMismatchText(brand.name));
  }

  /** The offer's signature seal in More details; the plain row when the order has no check. */
  private offerSeal(order: Order) {
    const text = pick(CARD);
    const signature = order.offerSignature;
    if (signature === undefined) {
      const verified = order.audit.some((e) => e.event === "offer_verified");
      return rows([[text.signature, verified ? text.verified(brand.name) : text.notVerified]]);
    }
    if (signature.state === "verified")
      return seal(
        "success",
        text.signedOffer(brand.name),
        text.signedOfferText(dayTime(signature.validUntil)),
      );
    if (signature.state === "expired")
      return seal("warning", text.offerExpired, text.offerExpiredText);
    return seal("danger", text.offerMismatch, text.offerMismatchText(brand.name));
  }

  /** Prototype P7: "You can still change or cancel it until … on the approval page." */
  private changeUntil(order: Order) {
    const cutoff = order.lines
      .map((l) => l.claims.cutoffAt)
      .filter((c): c is string => c !== null)
      .toSorted()[0];
    if (cutoff === undefined) return nothing;
    return html`<p class="open-until body-small">
      ${icon(clock16)}${pick(CARD).changeUntil(when(new Date(cutoff)))}
    </p>`;
  }

  /** v17 "More details": a disclosure at the bottom of every card, collapsed by default. */
  private details(order: Order) {
    const text = pick(CARD);
    const open = this.detailsOpen;
    const log = logUrl(order);
    return html`<aside class="details" part="details">
      <button
        class="toggle body-small"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="details-body"
        @click=${() => (this.detailsOpen = !open)}
      >
        <span class="more">${open ? text.fewerDetails : text.moreDetails}</span>${icon(chevronDown)}
        ${open ? nothing : html`<span class="hint">${text.offerAndSignature}</span>`}
      </button>
      <div id="details-body" class="details-body ${open ? "open" : ""}">
        <section class="group">
          <h3 class="section-title">${text.yourRequest}</h3>
          ${order.originalRequest === null ? nothing : html`<p>“${order.originalRequest}”</p>`}
          ${rows([
            [text.sent, when(new Date(order.createdAt))],
            [text.sentBy, order.agentId],
          ])}
        </section>
        <section class="group">
          <h3 class="section-title">${text.offer}</h3>
          ${rows([[text.offerNo, order.offerIds.join(", ")]])} ${this.offerSeal(order)}
        </section>
        <p class="details-links body-small">
          ${log === null ? nothing : html`<a href=${log} target="_blank" rel="noreferrer">${text.viewFullLog}</a>`}
        </p>
      </div>
    </aside>`;
  }

  override render() {
    const order = this.order;
    if (order === null) return nothing;
    const body =
      order.status !== "pending_approval" ? this.decidedBody(order) : this.pendingBody(order);
    return html`<article class="card" part="card">
      ${this.header(order)}
      ${
        this.busy && this.requoting
          ? html`<span class="shimmer load-bar" aria-hidden="true"></span>`
          : nothing
      }
      <div class="body">${body}</div>
      ${this.details(order)}
    </article>`;
  }
}

/** The order log page, on the server of the approval page; null without its URL. */
const logUrl = (order: Order) =>
  order.approvalUrl === null
    ? null
    : `${new URL(order.approvalUrl).origin}/views/order-timeline?order=${encodeURIComponent(order.orderId)}`;

/** Registers `<tt-approval-card>`; safe to call more than once. */
export function defineApprovalCard() {
  if (customElements.get("tt-approval-card") === undefined)
    customElements.define("tt-approval-card", ApprovalCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "tt-approval-card": ApprovalCard;
  }
}
