import {
  type DecideApprovalRequest,
  type OfferClaims,
  type Order,
  REASON_TEXT,
  type ReasonCode,
} from "@app/contract";
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
import { base } from "../../shared/styles.ts";
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
  switch (code) {
    case "SPEND_OVER_LIMIT":
      return warn("Over your order limit");
    case "NEW_PRODUCT":
      return {
        title: "New product",
        detail: `${order.customer} has not ordered a product in this order before`,
        tone: "info",
      };
    case "SUBSTITUTION":
      return {
        title: "Substitute proposed",
        detail: "a product in this order is out of stock",
        tone: "info",
      };
    case "CATEGORY_NOT_ALLOWED":
      return warn("Category not allowed", p === undefined ? null : `${p.category} is not allowed`);
    case "RELIABILITY_BELOW_MIN":
      return warn(
        "Delivery reliability below minimum",
        p?.deliveryReliability == null
          ? null
          : `on-time delivery ${Math.round(p.deliveryReliability * 100)}%`,
      );
    case "CO2_ABOVE_MAX":
      return warn(
        "CO₂ above maximum",
        p?.co2PerKg == null ? null : `${number(p.co2PerKg)} kg CO₂e per kg`,
      );
    case "UNCONFIRMED_ALLERGEN":
      return warn("Allergen information not confirmed");
    case "UNCONFIRMED_STOCK":
      return warn("Stock not confirmed");
    case "QUANTITY_UNUSUAL":
      return warn("Unusually large quantity");
    case "PAYMENT_TERMS":
      return warn(
        "Payment terms need approval",
        order.paymentTerms === "pay_on_order" ? "prepayment instead of invoice" : null,
      );
    default:
      return warn(REASON_TEXT[code]);
  }
}

/** The short title of the first reason, for list rows. */
export function reasonTitle(order: Order) {
  const first = order.reasons[0];
  if (first === undefined) return "Needs approval";
  return first === "SUBSTITUTION"
    ? "Substitute needs approval"
    : reasonCopy(first, order, order.lines[0]?.claims).title;
}

const isApproved = (o: Order) => o.status === "placed" || o.status === "awaiting_payment";
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;
/** The lines a check names for `reason` in the audit (`detail` is the product id). */
const linesFor = (order: Order, reason: ReasonCode) => {
  const ids = new Set(order.audit.filter((e) => e.reason === reason).map((e) => e.detail));
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
const outOfStock = (c: OfferClaims) =>
  `out of stock${c.nextDeliveryDate === null ? "" : ` until ${day(c.nextDeliveryDate)}`}`;
/** The element id of a product line, the target of its to-do. */
const lineId = (c: OfferClaims) => `line-${c.offerId}`;
/** Products shown before "Show N more products". */
const SHOWN = 3;
const round = (value: number) => Math.round(value * 100) / 100;
/** "Wednesday", for the agent prompts. */
const weekday = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(date));
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
    edits: { state: true },
    choicesOpen: { state: true },
    picked: { state: true },
    requoting: { state: true },
  };

  static override styles = [
    base,
    cardStyles,
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
      .total-block {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        padding: var(--spacing-lg);
        border: 2px solid var(--color-border-brand);
      }
      .total-block h3 {
        color: var(--color-link);
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
      .ordered-for {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-lg);
        background: var(--color-bg-brand-subtle);
      }
      .ordered-for dt {
        color: var(--color-text);
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
  /** Changed quantities in sales units by offer id; 0 means removed. */
  declare private edits: Record<string, number>;
  declare private choicesOpen: boolean;
  /** The alternative's offer id picked under "Other choices"; null keeps the proposal. */
  declare private picked: string | null;
  /** True from Confirm with changed amounts until the new quote arrives. */
  declare private requoting: boolean;

  constructor() {
    super();
    this.order = null;
    this.busy = false;
    this.canAsk = false;
    this.handling = "split";
    this.detailsOpen = false;
    this.allProducts = false;
    this.orderLimit = null;
    this.edits = {};
    this.choicesOpen = false;
    this.picked = null;
    this.requoting = false;
  }

  /** A new order (or a new version of it) starts without changes or picks. */
  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("order")) {
      this.edits = {};
      this.picked = null;
      this.handling = "split";
      this.requoting = false;
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
    if (order.status === "placed") return "Approved";
    if (order.status === "awaiting_payment") return "Approved · waiting for payment";
    if (order.status !== "pending_approval") return "Rejected";
    if (this.busy && this.requoting) return "Getting a new offer";
    // Nothing left to approve after changing amounts (prototype A2): the logo only.
    return this.todos(order).length > 0 ? "Approval required" : "";
  }

  /** v16: an order of products, named by its delivery day, with order number and count. */
  private header(order: Order) {
    const earliest = order.lines.map((l) => l.claims.deliveryDate).toSorted()[0];
    const title = html`<div class="headline">
      <h2 class="name">${earliest === undefined ? "Order" : `Order for ${day(earliest)}`}</h2>
      <p aria-live="polite">${money(this.total(order, "net"))}</p>
    </div>`;
    const facts = html`<dl class="facts">
      ${fact("Order no.", order.orderId)} ${fact("Products", String(order.lines.length))}
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
    return this.reasonTodos(order, lines);
  }

  private reasonTodos(order: Order, lines: OfferClaims[]): Todo[] {
    return order.reasons.flatMap((r): Todo[] => {
      const generic: Todo = {
        where: reasonCopy(r, order, lines[0]).title,
        target: "products",
        reason: REASON_TEXT[r],
        action: "Check the products",
      };
      switch (r) {
        case "SPEND_OVER_LIMIT": {
          // Gone once the changed amounts bring the order under the limit.
          const over = this.overLimit(order);
          if (over !== null && over <= 0) return [];
          return [
            {
              where: "Order total",
              target: "order-total",
              reason: "Order total is over your order limit",
              action:
                over === null
                  ? "Approve it as it is, or reject it"
                  : `Reduce by ${money(round(over))} to fit your limit`,
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
                    reason: `Out of stock${head.nextDeliveryDate === null ? "" : ` until ${day(head.nextDeliveryDate)}`}`,
                    action: "Choose a replacement",
                  },
                ];
          });
        case "NEW_PRODUCT": {
          const news = linesFor(order, "NEW_PRODUCT").filter((c) => this.quantity(c) > 0);
          if (linesFor(order, "NEW_PRODUCT").length === 0) return [generic];
          return news.map((c) => ({
            where: c.product.name,
            target: lineId(c),
            reason: "New product, not ordered before",
            action: "Confirm it, or remove it from the order",
          }));
        }
        case "UNCONFIRMED_STOCK": {
          const c = lines.find((l) => l.shortfall !== null || l.stock === "unconfirmed");
          return [
            {
              where: c?.product.name ?? "Stock",
              target: c === undefined ? "products" : lineId(c),
              reason:
                c?.shortfall == null
                  ? "Stock is not confirmed"
                  : `${amount(c.shortfall)} short for this delivery`,
              action: "Check the amount",
            },
          ];
        }
        default:
          return [generic];
      }
    });
  }

  /** Scrolls to a to-do's product or section, showing hidden products first, and focuses it. */
  private async goTo(order: Order, target: string) {
    const index = order.lines.findIndex((l) => `line-${l.offerId}` === target);
    if (index >= SHOWN) this.allProducts = true;
    await this.updateComplete;
    const element = this.renderRoot.querySelector<HTMLElement>(`#${CSS.escape(target)}`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    element?.focus({ preventScroll: true });
  }

  private todoBox(order: Order) {
    const items = this.todos(order);
    if (items.length === 0) return nothing;
    return html`<section class="todo" part="reason" aria-labelledby="todo-title">
      <h3 id="todo-title" class="todo-title">${icon(attention)}Needs your approval</h3>
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
          : html`<p class="label-small secondary">Or tell it what to do:</p>
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
    const over = this.overLimit(order);
    const limitRows =
      this.orderLimit === null || over === null
        ? nothing
        : html`<div class="limit">
              <dt>Your order limit</dt>
              <dd>${money(this.orderLimit)}</dd>
            </div>
            <div class="difference ${over > 0 ? "over" : "under"}">
              <dt class="label">
                ${icon(over > 0 ? warning16 : checkCircle)}${over > 0 ? "Over your limit" : "Under your limit"}
              </dt>
              <dd>${over > 0 ? signed(round(over)) : money(round(-over))}</dd>
            </div>`;
    return html`<section class="total-block" id="order-total" tabindex="-1" part="order-total">
      <h3>Order total</h3>
      <dl class="limit-rows body-small" aria-live="polite">
        <div>
          <dt>Total incl. VAT</dt>
          <dd>${money(round(this.total(order, "gross")))}</dd>
        </div>
        ${limitRows}
      </dl>
      ${
        over !== null && over <= 0
          ? nothing
          : this.agentHelp(
              "Let the agent reduce it",
              `Get order ${order.orderId} under my order limit. Keep the products we need most. Send me a new offer to approve.`,
              ["Remove the least needed", "Choose cheaper brands", "Order less of each"],
            )
      }
    </section>`;
  }

  /** The decision block of a flagged product: its choices and agent help (v17). */
  private lineDecision(order: Order, c: OfferClaims) {
    const sub = substitutionOf(order, c);
    if (sub !== null) {
      const head = sub.original ?? c;
      return html`${this.choices(sub)}
      ${this.agentHelp(
        "Let the agent find another",
        `${head.product.name} is ${outOfStock(head)}. Find the best replacement. Send me a new offer to approve.`,
        [
          "Same brand only",
          "Cheapest option",
          ...(head.nextDeliveryDate === null ? [] : [`Wait until ${day(head.nextDeliveryDate)}`]),
        ],
      )}`;
    }
    if (c.shortfall === null) return nothing;
    const pack = c.product.perSalesUnit;
    const later = c.nextDeliveryDate;
    const packs = (q: number) => (pack === null ? amount(c.quantity) : `${number(q)} packs`);
    const missing = pack === null ? c.shortfall.value : Math.round(c.shortfall.value / pack.value);
    const perPack = c.total.net / c.quantity.value;
    const options: { value: Handling; label: string; facts: [string, string][]; price: string }[] =
      later === null
        ? []
        : [
            {
              value: "split",
              label: "Split delivery",
              facts: [
                [day(c.deliveryDate), packs(c.quantity.value)],
                [day(later), packs(missing)],
              ],
              price: money(0),
            },
            {
              value: "later",
              label: `All on ${day(later)}`,
              facts: [[day(later), packs(c.quantity.value + missing)]],
              price: money(0),
            },
          ];
    options.push({
      value: "fewer",
      label: "Order fewer",
      facts: [[day(c.deliveryDate), `${packs(c.quantity.value)} only`]],
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
          <span class="choice-top">
            <span>${o.label}</span>
            ${o === first ? html`<span class="recommended label-small">Recommended</span>` : nothing}
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
        <legend class="section-title">How to handle the missing ${amount(c.shortfall)}</legend>
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
                ${open ? "Hide other choices" : `Other choices (${rest.length})`}${icon(chevronDown)}
              </button>`
        }
        ${open ? rest.map(option) : nothing}
      </fieldset>
      ${this.agentHelp(
        "Let the agent sort it out",
        `Only ${c.quantity.value} of ${all} ${c.product.name} packs arrive on ${weekday(c.deliveryDate)}. Find the best way to get all ${all}. Send me a new offer to approve.`,
        [
          ...(later === null ? [] : [`All on ${weekday(later)}`]),
          `Only ${packs(c.quantity.value)}`,
          "Another product",
        ],
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
        : html`${isNew ? html`<span class="tag label-small">New product</span>` : nothing}
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
                        aria-label="Remove ${head.product.name}"
                        @click=${() => this.setQuantity(head, 0)}
                      >
                        ${icon(bin)}
                      </button>
                    </div>
                  </div>`
                : amounts
            }`;
    return html`<li
      class="product ${flagged ? "flagged" : ""}"
      id="line-${c.offerId}"
      tabindex="-1"
    >
      ${summary} ${flagged ? this.lineDecision(order, c) : nothing}
    </li>`;
  }

  /** v17 products: flagged lines first and always shown; ready lines collapse after three. */
  private products(order: Order) {
    const pending = order.status === "pending_approval";
    const all = order.lines.map((l) => l.claims);
    const news = linesFor(order, "NEW_PRODUCT");
    const isFlagged = (c: OfferClaims) =>
      pending && (substitutionOf(order, c) !== null || c.shortfall !== null);
    // A replaced product is shown at the top of its substitute's box, not as its own line.
    const replaced = new Set(all.map((c) => (isFlagged(c) ? c.replaces : null)));
    const kept = (c: OfferClaims) => this.quantity(c) > 0;
    const flagged = all.filter((c) => isFlagged(c) && kept(c));
    // A new product leads the ready lines (MVP: a normal line with a tag).
    const ready = all
      .filter((c) => !isFlagged(c) && !replaced.has(c.productId) && kept(c))
      .toSorted((a, b) => Number(news.includes(b)) - Number(news.includes(a)));
    const removed = all.filter((c) => !kept(c));
    const visible = this.allProducts ? ready : ready.slice(0, SHOWN);
    const hidden = ready.length - SHOWN;
    return html`<section part="products" id="products" tabindex="-1">
      <h3 class="section-title">Products</h3>
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
                this.allProducts
                  ? "Show fewer products"
                  : `Show ${hidden} more product${hidden === 1 ? "" : "s"}`
              }${icon(chevronDown)}
            </button>`
          : nothing
      }
      ${removed.map(
        (c) =>
          html`<p class="removed body-small">
            <span>${c.product.name} removed</span>
            <button
              type="button"
              class="link-button"
              @click=${() => this.setQuantity(c, c.quantity.value)}
            >
              Undo
            </button>
          </p>`,
      )}
    </section>`;
  }

  private orderedFor(order: Order) {
    return html`<section class="ordered-for">
      <h3 class="section-title">Ordered for</h3>
      ${rows([["Customer", order.customer]])}
    </section>`;
  }

  /** The primary label, and while sending its busy form ("Confirming…", prototype P6). */
  private approveLabel(order: Order) {
    // "Approve order" while the order is over the limit; else "Confirm order".
    const over = this.overLimit(order);
    const confirm = !order.reasons.includes("SPEND_OVER_LIMIT") || (over !== null && over <= 0);
    if (this.busy && !this.requoting) return confirm ? "Confirming…" : "Approving…";
    return confirm ? "Confirm order" : "Approve order";
  }

  private pendingBody(order: Order) {
    const changed = this.changed(order);
    const gettingOffer =
      this.busy && this.requoting
        ? html`<p class="getting strong" role="status">
            <span class="spinner"></span>Getting a new offer and ordering…
          </p>`
        : nothing;
    const confirm = () => {
      if (!changed) return this.decide(this.approveRequest(order));
      this.requoting = true;
      this.decide(
        { decision: "edit", proposalVersion: order.proposalVersion, changes: this.changes(order) },
        "tt-confirm-changes",
      );
    };
    return html`${gettingOffer} ${this.todoBox(order)} ${this.totalBlock(order)}
      ${this.products(order)} ${this.orderedFor(order)}
      ${
        changed
          ? html`<p class="body-small">
              You changed amounts. Confirming gets the new price and places the order.
            </p>`
          : nothing
      }
      <p class="total-row">
        <span>Order total</span
        ><span class="value" aria-live="polite">${money(this.total(order, "net"))}</span>
      </p>
      <div class="actions" part="actions">
        <button
          part="button approve"
          class="btn primary"
          aria-busy=${this.busy ? "true" : "false"}
          @click=${() => (this.busy ? undefined : confirm())}
        >
          ${
            this.busy && !this.requoting
              ? html`<span class="spinner" role="status" aria-label="Sending"></span>`
              : nothing
          }
          ${this.approveLabel(order)}
        </button>
        <button
          part="button reject"
          class="btn brand"
          ?disabled=${this.busy}
          @click=${() =>
            // Just reject: no reason form yet, and the agent does not try again.
            this.decide({
              decision: "reject",
              next: "stop",
              proposalVersion: order.proposalVersion,
            })}
        >
          Reject
        </button>
      </div>
      ${
        this.canAsk
          ? html`<button
              type="button"
              class="btn secondary talk"
              part="button talk"
              @click=${() =>
                this.ask(
                  `I'd like to discuss order ${order.orderId} before I decide. Give me a short summary and ask what I want to change.`,
                  "tt-talk",
                )}
            >
              ${icon(agent16)}Discuss order with agent
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
    return html`<fieldset class="options">
      <legend class="section-title">Replace with</legend>
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
              ${open ? "Hide other choices" : `Other choices (${others.length})`}${icon(chevronDown)}
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
    return html`<label class="choice ${selected ? "selected" : ""}">
      <input
        type="radio"
        name="product-choice"
        .checked=${selected}
        @change=${() => (this.picked = recommended ? null : c.offerId)}
      />
      <span class="choice-body">
        <span class="choice-top">
          <span>${c.product.name}</span>
          ${recommended ? html`<span class="recommended label-small">Recommended</span>` : nothing}
          <span class="strong"
            >${c === reference ? money(c.total.net) : signed(c.total.net - reference.total.net)}</span
          >
        </span>
        <dl class="option-facts body-small">
          <div>
            <dt class="label-small secondary">Pack</dt>
            <dd>
              ${pack === null ? amount(c.quantity) : `${number(c.quantity.value)} × ${amount(pack)}`}
            </dd>
          </div>
          <div>
            <dt class="label-small secondary">Price</dt>
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
    return html`<div class="stepper">
      <button
        type="button"
        aria-label="Decrease ${name}"
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
        aria-label="Increase ${name}"
        @click=${() => this.setQuantity(c, q + 1)}
      >
        ${icon(plus16)}
      </button>
    </div>`;
  }

  private decidedBody(order: Order) {
    const decision = order.decision;
    const by =
      decision === null
        ? null
        : `${decision.by === "approver" ? "You" : decision.by}, ${when(new Date(decision.at)).replace("Today", "today")}`;
    const earliest = order.lines.map((l) => l.claims.deliveryDate).toSorted()[0];
    const delivery = earliest === undefined ? "" : `Delivery ${day(earliest)}. `;
    const result =
      order.status === "placed"
        ? {
            tone: "success",
            svg: checkCircle,
            title: "Order sent to Valio Aimo",
            text: `${delivery}Confirmation also on the approval page.`,
          }
        : order.status === "awaiting_payment"
          ? {
              tone: "",
              svg: clockIcon,
              title: "Approved. Waiting for payment",
              text: "The order is sent to the wholesaler when the payment is confirmed.",
            }
          : decision?.next === "alternatives"
            ? {
                tone: "",
                svg: search,
                title: "Rejected. The agent looks for a better option",
                text: "A new approval request comes here if the agent finds one.",
              }
            : decision?.next === "stop"
              ? {
                  tone: "",
                  svg: xCircle,
                  title: "Rejected. No order placed.",
                  text: "Nothing is ordered unless you ask the agent again.",
                }
              : {
                  tone: "danger",
                  svg: xCircle,
                  title: "Rejected",
                  text: order.reasons.map((r) => REASON_TEXT[r]).join(" "),
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
          ? html`${
              order.status === "awaiting_payment"
                ? rows([
                    ["Approved by", by],
                    ["Payment", "Prepayment"],
                  ])
                : nothing
            }
            ${
              order.status === "placed"
                ? rows([
                    ["Order no.", order.orderId],
                    ["Delivery", earliest === undefined ? null : day(earliest)],
                    ["Total", money(order.total.net)],
                    ["Confirmed by", decision === null ? null : "You"],
                    ["Confirmed at", decision === null ? null : timeOnly(new Date(decision.at))],
                  ])
                : nothing
            }
            ${this.changeUntil(order)} ${this.products(order)}`
          : decision?.next === "stop"
            ? nothing
            : rows([["Your note", note === "" ? null : `“${note}”`]])
      }
      ${this.orderedFor(order)}`;
  }

  /** Prototype P7: "You can still change or cancel it until … on the approval page." */
  private changeUntil(order: Order) {
    const cutoff = order.lines
      .map((l) => l.claims.cutoffAt)
      .filter((c): c is string => c !== null)
      .toSorted()[0];
    if (cutoff === undefined) return nothing;
    return html`<p class="open-until body-small">
      ${icon(clock16)}You can still change or cancel it until ${when(new Date(cutoff))} on the
      approval page.
    </p>`;
  }

  /** v17 "More details": a disclosure at the bottom of every card, collapsed by default. */
  private details(order: Order) {
    const verified = order.audit.some((e) => e.event === "offer_verified");
    const open = this.detailsOpen;
    const log =
      order.approvalUrl === null
        ? null
        : `${new URL(order.approvalUrl).origin}/views/order-timeline?order=${encodeURIComponent(order.orderId)}`;
    return html`<aside class="details" part="details">
      <button
        class="toggle body-small"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="details-body"
        @click=${() => (this.detailsOpen = !open)}
      >
        <span class="more">${open ? "Fewer details" : "More details"}</span>${icon(chevronDown)}
        ${open ? nothing : html`<span class="hint">Offer and signature</span>`}
      </button>
      <div id="details-body" class="details-body ${open ? "open" : ""}">
        <section class="group">
          <h3 class="section-title">Your request</h3>
          ${order.originalRequest === null ? nothing : html`<p>“${order.originalRequest}”</p>`}
          ${rows([
            ["Sent", when(new Date(order.createdAt))],
            ["Sent by", order.agentId],
          ])}
        </section>
        <section class="group">
          <h3 class="section-title">Offer</h3>
          ${rows([
            ["Offer no.", order.offerIds.join(", ")],
            ["Signature", verified ? "Verified by Valio Aimo" : "Not verified"],
          ])}
        </section>
        <p class="details-links body-small">
          ${log === null ? nothing : html`<a href=${log} target="_blank" rel="noreferrer">View full log</a>`}
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
      <div class="body">${body}</div>
      ${this.details(order)}
    </article>`;
  }
}

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
