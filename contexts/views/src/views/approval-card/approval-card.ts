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
import bullet from "../../shared/icons/bullet.svg?raw";
import info16Warning from "../../shared/icons/info-16-warning.svg?raw";
import info16 from "../../shared/icons/info-16.svg?raw";
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
  unit,
  when,
} from "./parts.ts";

// Figma: Junction 2026 › Screens › "Approval request — v17 (reasons on to-dos)", with the
// v11–v16 style and the prototype flows (choose another product, agent help, edit products).
// Every approval is an order of products, in one column at any width. Fields the order does
// not carry (order limit, kitchen, on behalf of, the agent's reason for a substitute) are left
// out until the contract has them.

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

const REQUOTE: ReadonlySet<ReasonCode> = new Set(["PRICE_CHANGED", "AVAILABILITY_DIFFERS"]);
const isApproved = (o: Order) => o.status === "placed" || o.status === "awaiting_payment";
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;
const daysBetween = (from: string, to: string) =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
const dayShift = (days: number) =>
  `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "later" : "earlier"}`;
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
/** The number typed into a quantity field, or NaN. */
const typed = (e: Event) => (e.target instanceof HTMLInputElement ? Number(e.target.value) : NaN);

/**
 * One order for a human decision. Framework-agnostic: set `order`, `busy` and `canAsk`, listen
 * for `tt-decide` (detail: DecideApprovalRequest), `tt-ask-agent` (detail: the message for
 * the agent, who then updates the order) and `tt-talk` (a message that starts a conversation). Restyle through the tokens in shared/styles.ts or the `part` names.
 */
export class ApprovalCard extends LitElement {
  static override properties = {
    order: { attribute: false },
    busy: { type: Boolean },
    canAsk: { type: Boolean, attribute: "can-ask" },
    handling: { state: true },
    detailsOpen: { state: true },
    allProducts: { state: true },
    editing: { state: true },
    edits: { state: true },
    discarding: { state: true },
    choicesOpen: { state: true },
    picked: { state: true },
    savedEdit: { state: true },
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
        background: var(--color-yellow-aimo);
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
      .changes {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }
      .change {
        display: grid;
        grid-template-columns: 96px 1fr auto;
        gap: var(--spacing-md);
        padding: var(--spacing-md) 0;
        border-bottom: 1px solid var(--color-border);
      }
      .change .now,
      .change .delta {
        font-weight: 600;
      }
      .change .delta {
        color: var(--color-text-warning);
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
      .products-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
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
      .option {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: var(--spacing-md);
        align-items: start;
        padding: var(--spacing-md) var(--spacing-lg);
        border-left: 4px solid var(--color-border-brand);
        background: var(--color-bg-brand-subtle);
      }
      .radio {
        width: 18px;
        height: 18px;
        margin-top: 2px;
        border: 2px solid var(--color-border-brand);
        border-radius: var(--radius-full);
        background: var(--color-border-brand);
        box-shadow: inset 0 0 0 3px var(--color-white);
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
      /* Prototype P5: − amount + stepper and Remove under each product. */
      .edit-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-md);
        padding-top: var(--spacing-sm);
      }
      .stepper {
        display: flex;
        border: 1px solid var(--color-border-strong);
      }
      .stepper button {
        width: 40px;
        border: 0;
        background: var(--color-white);
        color: var(--color-text-brand);
        font: inherit;
        font-size: var(--font-size-xl);
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
      }
      .stepper button:disabled {
        color: var(--color-border-strong);
        cursor: not-allowed;
      }
      .stepper label {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border-inline: 1px solid var(--color-border-strong);
        font-size: var(--font-size-xs);
      }
      .stepper input {
        width: 3.5rem;
        padding: 0;
        border: 0;
        color: var(--color-text);
        font: inherit;
        font-size: var(--font-size-sm);
        text-align: right;
        -moz-appearance: textfield;
      }
      .stepper input::-webkit-inner-spin-button {
        appearance: none;
      }
      .removed {
        display: flex;
        justify-content: space-between;
        padding: var(--spacing-md) 0;
      }
      .discard {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-lg);
        background: var(--color-bg-warning);
      }
      .discard-title {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        color: var(--color-text-warning);
      }
      .btn.danger {
        border-radius: var(--border-radius-md);
        background: var(--color-text-danger);
        color: var(--color-white);
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
  declare private editing: boolean;
  /** Edited quantities in sales units by offer id; 0 means removed. */
  declare private edits: Record<string, number>;
  declare private discarding: boolean;
  declare private choicesOpen: boolean;
  /** The alternative's offer id picked under "Other choices"; null keeps the proposal. */
  declare private picked: string | null;
  /** True from Save in edit mode until the new offer arrives. */
  declare private savedEdit: boolean;

  constructor() {
    super();
    this.order = null;
    this.busy = false;
    this.canAsk = false;
    this.handling = "split";
    this.detailsOpen = false;
    this.allProducts = false;
    this.editing = false;
    this.edits = {};
    this.discarding = false;
    this.choicesOpen = false;
    this.picked = null;
    this.savedEdit = false;
  }

  /** A new order (or a new version of it) starts without edits or picks. */
  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("order")) {
      this.stopEditing();
      this.picked = null;
      this.handling = "split";
      this.savedEdit = false;
    }
  }

  private decide(request: DecideApprovalRequest) {
    this.dispatchEvent(
      new CustomEvent("tt-decide", { detail: request, bubbles: true, composed: true }),
    );
  }

  private eyebrow(order: Order) {
    if (order.status === "placed") return "Approved";
    if (order.status === "awaiting_payment") return "Approved · waiting for payment";
    if (order.status !== "pending_approval") return "Rejected";
    if (this.editing) return "Editing products";
    if (this.busy && this.savedEdit) return "Getting a new offer";
    return "Approval required";
  }

  /** v16: an order of products, named by its delivery day, with order number and count. */
  private header(order: Order) {
    const earliest = order.lines.map((l) => l.claims.deliveryDate).toSorted()[0];
    const title = html`<div class="headline">
      <h2 class="name">${earliest === undefined ? "Order" : `Order for ${day(earliest)}`}</h2>
      <p aria-live="polite">${money(this.editing ? this.editedTotal(order) : order.total.net)}</p>
    </div>`;
    const facts = html`<dl class="facts">
      ${fact("Order no.", order.orderId)} ${fact("Products", String(order.lines.length))}
    </dl>`;
    const pill = order.status === "pending_approval" && !this.editing;
    return brandHeader(this.eyebrow(order), title, facts, pill);
  }

  /** The requote, if any: the summed change of total and delivery. */
  private change(order: Order) {
    const last = order.requotes.at(-1);
    if (last === undefined) return null;
    const total = order.total.net;
    const before = total - last.current.total.net + last.previous.total.net;
    return {
      total,
      before,
      days: daysBetween(last.previous.deliveryDate, last.current.deliveryDate),
      deliveryBefore: last.previous.deliveryDate,
      deliveryNow: last.current.deliveryDate,
    };
  }

  /** v17 to-dos: one per thing the approver should look at, linked to where it is. */
  private todos(order: Order): Todo[] {
    const lines = order.lines.map((l) => l.claims);
    // Prototype A4: after "Save only" the approver checks the new offer for their edit.
    const edited: Todo[] = order.audit.some((e) => e.event === "edited")
      ? [
          {
            where: "New offer",
            target: "products",
            reason: "Your changes made a new offer",
            action: "Check the new offer",
          },
        ]
      : [];
    return [...edited, ...this.reasonTodos(order, lines)];
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
        case "SPEND_OVER_LIMIT":
          return [
            {
              where: "Order total",
              target: "products",
              reason: "Order total is over your order limit",
              action: "Approve it as it is, or reject it",
            },
          ];
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
        case "PRICE_CHANGED":
          return order.requotes.map((q) => ({
            where: q.current.product.name,
            target: lineId(q.current),
            reason: "Price changed after the offer was made",
            action: "Check the new price",
          }));
        case "AVAILABILITY_DIFFERS":
          return [
            {
              where: "Delivery date",
              target: "what-changed",
              reason: "Delivery date changed after the offer was made",
              action: "Check the new date",
            },
          ];
        case "NEW_PRODUCT": {
          const news = linesFor(order, "NEW_PRODUCT");
          if (news.length === 0) return [generic];
          return news.map((c) => ({
            where: c.product.name,
            target: lineId(c),
            reason: "New product, not ordered before",
            action: "Confirm it, or remove it with Edit products",
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

  /** The hint above the order-level agent help (v17), for an order over the limit. */
  private guidance(order: Order) {
    return order.reasons.includes("SPEND_OVER_LIMIT")
      ? html`<p class="body-small">
          Edit products yourself, let the agent get it under the limit, or approve the order as it
          is.
        </p>`
      : nothing;
  }

  /** v16 "What changed" for a re-quoted order: total and delivery, then and now. */
  private whatChanged(order: Order) {
    const c = this.change(order);
    if (c === null) return nothing;
    return html`<section class="changes" id="what-changed" tabindex="-1">
      <h3 class="section-title">What changed</h3>
      <div class="change">
        <span>Total</span>
        <span
          ><span class="now">${money(c.total)}</span><br /><span class="body-small"
            >was ${money(c.before)}</span
          ></span
        >
        <span class="delta">${c.total === c.before ? "" : signed(c.total - c.before)}</span>
      </div>
      <div class="change">
        <span>Delivery</span>
        <span
          ><span class="now">${day(c.deliveryNow)}</span><br /><span class="body-small"
            >was ${day(c.deliveryBefore)}</span
          ></span
        >
        <span class="delta">${c.days === 0 ? "" : dayShift(c.days)}</span>
      </div>
    </section>`;
  }

  /** The note under a product that something applies to; a price change is a warning (v17). */
  private lineNote(order: Order, c: OfferClaims): { text: string; warning: boolean } | null {
    if (substitutionOf(order, c) !== null)
      return { text: `Substitute proposed · ${outOfStock(c)}`, warning: false };
    const requote = order.requotes.find((r) => r.current.offerId === c.offerId);
    if (requote !== undefined)
      return {
        text: `Price changed · was ${money(requote.previous.total.net)} (${signed(c.total.net - requote.previous.total.net)})`,
        warning: true,
      };
    if (c.shortfall !== null)
      return {
        text: `${amount(c.shortfall)} short${c.nextDeliveryDate === null ? "" : ` · rest from ${day(c.nextDeliveryDate)}`}`,
        warning: true,
      };
    if (c.stock === "unconfirmed") return { text: "Stock not confirmed", warning: true };
    if (linesFor(order, "NEW_PRODUCT").includes(c))
      return { text: "New product · not ordered before", warning: false };
    return null;
  }

  /**
   * v17 agent help: the ready prompt and each chip go straight to the chat as a message about
   * `subject`. Only in a chat (`canAsk`).
   */
  private agentHelp(subject: string, label: string, prompt: string, chips: string[]) {
    if (!this.canAsk) return nothing;
    return html`<div class="agent-help" part="agent-help">
      <button type="button" class="btn secondary" @click=${() => this.ask(subject, prompt)}>
        ${label}
      </button>
      <p class="label-small secondary">Or tell it what to do:</p>
      <div class="chips">
        ${chips.map(
          (chip) =>
            html`<button type="button" class="chip" @click=${() => this.ask(subject, chip)}>
              ${chip}
            </button>`,
        )}
      </div>
    </div>`;
  }

  /** Sends a message to the agent; `tt-ask-agent` collapses the card while the agent works. */
  private ask(subject: string, text: string, type = "tt-ask-agent") {
    this.dispatchEvent(
      new CustomEvent(type, { detail: `About ${subject}: ${text}`, bubbles: true, composed: true }),
    );
  }

  /** The order-level agent help for the issue that applies to the whole order (v17). */
  private orderHelp(order: Order) {
    if (order.reasons.includes("SPEND_OVER_LIMIT"))
      return this.agentHelp(
        "the order",
        "Let the agent reduce it",
        "reduce it to within my order limit",
        ["Remove the least needed", "Choose cheaper brands", "Order less of each"],
      );
    if (order.reasons.some((r) => REQUOTE.has(r)))
      return this.agentHelp(
        "the order",
        "Let the agent find a better offer",
        "find a better offer",
        ["Keep the earlier delivery", "Find a cheaper one", "Remove the changed product"],
      );
    if (order.reasons.includes("NEW_PRODUCT") && linesFor(order, "NEW_PRODUCT").length === 0)
      return html`<p class="body-small">
          Confirm the order to include the new product, or remove it with Edit products.
        </p>
        ${this.agentHelp("the new product", "Let the agent find another", "find another product", [
          "Use our usual product",
          "Remove it",
        ])}`;
    return nothing;
  }

  /** The decision block of a flagged product: its choices and agent help (v17). */
  private lineDecision(order: Order, c: OfferClaims) {
    const sub = substitutionOf(order, c);
    if (sub !== null) {
      const head = sub.original ?? c;
      return html`<h4 class="section-title">Replace with</h4>
        ${this.choices(sub)}
        ${this.agentHelp(
          head.product.name,
          "Let the agent find another",
          "find another substitute",
          [
            "Same brand only",
            "Cheapest option",
            ...(head.nextDeliveryDate === null ? [] : [`Wait until ${day(head.nextDeliveryDate)}`]),
          ],
        )}`;
    }
    if (c.shortfall === null)
      return linesFor(order, "NEW_PRODUCT").includes(c)
        ? this.agentHelp(c.product.name, "Let the agent find another", "find another product", [
            "Use our usual product",
            "Remove it",
          ])
        : nothing;
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
              price: "No price change",
            },
            {
              value: "later",
              label: `All on ${day(later)}`,
              facts: [[day(later), packs(c.quantity.value + missing)]],
              price: "No price change",
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
    return html`<h4 class="section-title">How to handle the missing ${amount(c.shortfall)}</h4>
      <div class="options" role="radiogroup" aria-label="How to handle the missing amount">
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
      </div>`;
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
    const note = this.lineNote(order, c);
    // A flagged substitute heads its box with the product it replaces (when the order has it)
    // and shows itself as the recommended "Replace with" option.
    const head = flagged && c.replaces !== null ? substitutionOf(order, c)?.original : c;
    const pack = head?.product.perSalesUnit ?? null;
    const summary =
      head === undefined
        ? nothing
        : html`<p class="product-top">
              <span class="product-name">${head.product.name}</span
              ><span>${money(head.total.net)}</span>
            </p>
            <p class="product-amounts body-small">
              <span>${amount(stdUnits(head))}</span>
              ${
                pack === null
                  ? nothing
                  : html`<span class="secondary"
                      >${number(head.quantity.value)} × ${amount(pack)}</span
                    >`
              }
            </p>`;
    return html`<li
      class="product ${flagged ? "flagged" : ""}"
      id="line-${c.offerId}"
      tabindex="-1"
    >
      ${summary}
      ${
        note === null
          ? nothing
          : html`<p class="product-note ${note.warning ? "warning" : ""}">
              ${icon(note.warning ? info16Warning : info16)}${note.text}
            </p>`
      }
      ${flagged ? this.lineDecision(order, c) : nothing}
    </li>`;
  }

  /** v17 products: flagged lines first and always shown; ready lines collapse after three. */
  private products(order: Order) {
    const pending = order.status === "pending_approval";
    const all = order.lines.map((l) => l.claims);
    const news = linesFor(order, "NEW_PRODUCT");
    const isFlagged = (c: OfferClaims) =>
      pending && (substitutionOf(order, c) !== null || c.shortfall !== null || news.includes(c));
    // A replaced product is shown at the top of its substitute's box, not as its own line.
    const replaced = new Set(all.map((c) => (isFlagged(c) ? c.replaces : null)));
    const flagged = all.filter(isFlagged);
    const ready = all.filter((c) => !isFlagged(c) && !replaced.has(c.productId));
    const visible = this.allProducts ? ready : ready.slice(0, SHOWN);
    const hidden = ready.length - SHOWN;
    return html`<section part="products" id="products" tabindex="-1">
      <div class="products-head">
        <h3 class="section-title">Products</h3>
        ${
          pending
            ? html`<button
                type="button"
                class="link-button"
                part="edit-products"
                ?disabled=${this.busy}
                @click=${() => (this.editing = true)}
              >
                Edit products
              </button>`
            : nothing
        }
      </div>
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
    </section>`;
  }

  private orderedFor(order: Order) {
    return html`<section class="ordered-for">
      <h3 class="section-title">Ordered for</h3>
      ${rows([["Customer", order.customer]])}
    </section>`;
  }

  /** "Open until 23:32 today. Prices are fixed until then." from the first offer to expire. */
  private openUntil(order: Order) {
    const exp = Math.min(...order.lines.map((l) => l.claims.exp));
    if (!Number.isFinite(exp)) return nothing;
    const at = when(new Date(exp * 1000));
    const until = at.startsWith("Today ") ? `${at.slice(6)} today` : at;
    return html`<p class="open-until body-small">
      ${icon(clock16)}Open until ${until}. Prices are fixed until then.
    </p>`;
  }

  /** The primary label, and while sending its busy form ("Confirming…", prototype P6). */
  private approveLabel(order: Order) {
    const confirm = order.reasons.includes("SUBSTITUTION") || order.reasons.includes("NEW_PRODUCT");
    if (this.busy && !this.savedEdit) return confirm ? "Confirming…" : "Approving…";
    if (order.reasons.some((r) => REQUOTE.has(r))) return "Approve new price";
    return confirm ? "Confirm order" : "Approve order";
  }

  private pendingBody(order: Order) {
    const gettingOffer =
      this.busy && this.savedEdit
        ? html`<p class="getting strong" role="status">
            <span class="spinner"></span>Getting a new offer for your changes…
          </p>`
        : nothing;
    return html`${gettingOffer} ${this.todoBox(order)} ${this.guidance(order)}
      ${this.whatChanged(order)} ${this.orderHelp(order)} ${this.products(order)}
      ${this.orderedFor(order)} ${this.openUntil(order)}
      <div class="actions" part="actions">
        <button
          part="button approve"
          class="btn primary"
          ?disabled=${this.busy}
          aria-busy=${this.busy ? "true" : "false"}
          @click=${() => this.decide(this.approveRequest(order))}
        >
          ${
            this.busy && !this.savedEdit
              ? html`<span class="spinner" role="status" aria-label="Sending"></span>`
              : nothing
          }
          ${this.approveLabel(order)}
        </button>
        <button
          part="button reject"
          class="btn ghost"
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
              class="btn ghost talk"
              part="button talk"
              @click=${() => this.ask("the order", "I have a question.", "tt-talk")}
            >
              Talk to the agent
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
    return html`<div class="options" role="radiogroup" aria-label="Replace with">
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
    </div>`;
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

  /** The order total at the edited quantities, in whole euros; the new offer sets the exact one. */
  private editedTotal(order: Order) {
    return Math.round(
      order.lines.reduce(
        (sum, { claims: c }) => sum + (c.total.net / c.quantity.value) * this.quantity(c),
        0,
      ),
    );
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

  private stopEditing() {
    this.editing = false;
    this.edits = {};
    this.discarding = false;
  }

  /** Prototype P5: one product with its amount stepper and Remove. */
  private editLine(c: OfferClaims) {
    const q = this.quantity(c);
    const edited = { ...c, quantity: { ...c.quantity, value: q } };
    const pack = c.product.perSalesUnit;
    const name = c.product.name;
    return html`<li class="product">
      <p class="product-top">
        <span class="product-name">${name}</span
        ><span>${money(Math.round((c.total.net / c.quantity.value) * q))}</span>
      </p>
      <p class="product-amounts body-small">
        <span>${amount(stdUnits(edited))}</span>
        ${pack === null ? nothing : html`<span class="secondary">${number(q)} × ${amount(pack)}</span>`}
      </p>
      <div class="edit-row">
        <div class="stepper">
          <button
            type="button"
            aria-label="Less ${name}"
            ?disabled=${q <= 1}
            @click=${() => this.setQuantity(c, q - 1)}
          >
            −
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
            aria-label="More ${name}"
            @click=${() => this.setQuantity(c, q + 1)}
          >
            +
          </button>
        </div>
        <button type="button" class="link-button" @click=${() => this.setQuantity(c, 0)}>
          Remove
        </button>
      </div>
    </li>`;
  }

  /** Prototype A2x: Cancel with unsaved changes asks first, saying what goes back. */
  private discardBox(order: Order) {
    const back = order.lines
      .map((l) => l.claims)
      .filter((c) => this.quantity(c) !== c.quantity.value)
      .map((c) =>
        this.quantity(c) === 0
          ? `${c.product.name} comes back`
          : `${c.product.name} goes back to ${amount(c.quantity)}`,
      );
    return html`<div class="discard" role="alert">
        <p class="discard-title">${icon(warning16)}Discard your changes?</p>
        <p class="body-small">${back.join(", ")}.</p>
      </div>
      <div class="actions">
        <button class="btn secondary" @click=${() => (this.discarding = false)}>
          Keep editing
        </button>
        <button class="btn danger" @click=${() => this.stopEditing()}>Discard changes</button>
      </div>`;
  }

  /**
   * Prototype P5 and A2: change amounts or remove products. Save sends the `edit` decision and
   * goes back to the order, which waits for the new offer.
   */
  private editBody(order: Order) {
    const lines = order.lines.map((l) => l.claims);
    const kept = lines.filter((c) => this.quantity(c) > 0);
    const removed = lines.filter((c) => this.quantity(c) === 0);
    const changes = this.changes(order);
    const canSave = changes.length > 0 && kept.length > 0;
    const save = () => {
      this.decide({ decision: "edit", proposalVersion: order.proposalVersion, changes });
      this.savedEdit = true;
      this.stopEditing();
    };
    return html`<section part="products">
        <h3 class="section-title">Products</h3>
        <ul class="product-list">
          ${kept.map((c) => this.editLine(c))}
        </ul>
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
      </section>
      ${this.orderedFor(order)}
      ${
        this.discarding
          ? this.discardBox(order)
          : html`<div class="actions">
              <button part="button save" class="btn primary" ?disabled=${!canSave} @click=${save}>
                Save
              </button>
              <button
                class="btn ghost"
                @click=${() => (changes.length === 0 ? this.stopEditing() : (this.discarding = true))}
              >
                Cancel
              </button>
            </div>`
      }`;
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
                  tone: "danger",
                  svg: xCircle,
                  title: "Rejected. The agent stops",
                  text: "No order was placed.",
                }
              : {
                  tone: "danger",
                  svg: xCircle,
                  title: "Rejected",
                  text: order.reasons.map((r) => REASON_TEXT[r]).join(" "),
                };
    const note = decision?.note ?? "";
    return html`<div class="result ${result.tone}" part="result" role="status">
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
            ${this.changeUntil(order)} ${this.products(order)}`
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
          ${
            order.status === "pending_approval" && order.approvalUrl !== null
              ? html`<a
                  part="approval-link"
                  href=${order.approvalUrl}
                  target="_blank"
                  rel="noreferrer"
                  >Open the approval page</a
                >`
              : nothing
          }
        </p>
      </div>
    </aside>`;
  }

  override render() {
    const order = this.order;
    if (order === null) return nothing;
    const body =
      order.status !== "pending_approval"
        ? this.decidedBody(order)
        : this.editing
          ? this.editBody(order)
          : this.pendingBody(order);
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
