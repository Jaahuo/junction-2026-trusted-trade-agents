import {
  type DecideApprovalRequest,
  type OfferClaims,
  type Order,
  REASON_TEXT,
  type ReasonCode,
} from "@app/contract";
import { css, html, LitElement, nothing } from "lit";
import checkCircle from "../../shared/icons/check-circle.svg?raw";
import chevronDown from "../../shared/icons/chevron-down.svg?raw";
import clock16 from "../../shared/icons/clock-16.svg?raw";
import clockIcon from "../../shared/icons/clock.svg?raw";
import attention from "../../shared/icons/attention.svg?raw";
import bullet from "../../shared/icons/bullet.svg?raw";
import info16Warning from "../../shared/icons/info-16-warning.svg?raw";
import info16 from "../../shared/icons/info-16.svg?raw";
import search from "../../shared/icons/search.svg?raw";
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
  when,
} from "./parts.ts";

// Figma: Junction 2026 › Screens › "Approval request — v17 (reasons on to-dos)", with the
// v11–v16 style. Every approval is an order of products, in one column at any width.
// Fields the order does not carry (order limit,
// kitchen, on behalf of) and per-product actions (replace, ask the agent, edit products)
// are left out until the contract has them.

type Reason = { title: string; detail: string | null; tone: "warning" | "info" };

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

/** Reject reasons from the design; they go to the agent with the note. */
const REJECT_REASONS = ["Too expensive", "Wrong product", "Not needed", "Other"] as const;

/** Prototype P8 "After rejecting": what the agent does next (DecideApprovalRequest.next). */
const AFTER_REJECT = [
  {
    next: "alternatives",
    label: "Look for a better option",
    hint: "The agent tries again with your note.",
  },
  { next: "stop", label: "Stop", hint: "No order is placed." },
] as const;

const REQUOTE: ReadonlySet<ReasonCode> = new Set(["PRICE_CHANGED", "AVAILABILITY_DIFFERS"]);
const isApproved = (o: Order) => o.status === "placed" || o.status === "awaiting_payment";
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;
const daysBetween = (from: string, to: string) =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
const dayShift = (days: number) =>
  `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "later" : "earlier"}`;
/** The element id of a product line, the target of its to-do. */
const lineId = (c: OfferClaims) => `line-${c.offerId}`;
/** Products shown before "Show N more products". */
const SHOWN = 3;

/**
 * One order for a human decision. Framework-agnostic: set `order` and `busy`, listen for
 * `tt-decide` (detail: DecideApprovalRequest). Restyle through the tokens in shared/styles.ts
 * or the `part` names.
 */
export class ApprovalCard extends LitElement {
  static override properties = {
    order: { attribute: false },
    busy: { type: Boolean },
    rejecting: { state: true },
    rejectReason: { state: true },
    afterReject: { state: true },
    detailsOpen: { state: true },
    allProducts: { state: true },
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
      .after-reject {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        margin: 0;
        padding: 0;
        border: 0;
      }
      .after-reject legend {
        margin-bottom: var(--spacing-sm);
        padding: 0;
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
  declare private rejecting: boolean;
  declare private rejectReason: (typeof REJECT_REASONS)[number] | null;
  declare private afterReject: (typeof AFTER_REJECT)[number]["next"];
  declare private detailsOpen: boolean;
  declare private allProducts: boolean;

  constructor() {
    super();
    this.order = null;
    this.busy = false;
    this.rejecting = false;
    this.rejectReason = null;
    this.afterReject = "alternatives";
    this.detailsOpen = false;
    this.allProducts = false;
  }

  private decide(request: DecideApprovalRequest) {
    this.dispatchEvent(
      new CustomEvent("tt-decide", { detail: request, bubbles: true, composed: true }),
    );
  }

  private reject(order: Order) {
    const field = this.renderRoot.querySelector<HTMLInputElement>("#reject-note");
    const note = [this.rejectReason, field?.value.trim()].filter(Boolean).join(": ");
    this.decide({
      decision: "reject",
      next: this.afterReject,
      proposalVersion: order.proposalVersion,
      ...(note === "" ? {} : { note }),
    });
  }

  private eyebrow(order: Order) {
    if (order.status === "placed") return "Approved";
    if (order.status === "awaiting_payment") return "Approved · waiting for payment";
    if (order.status !== "pending_approval") return "Rejected";
    if (this.rejecting) return "Rejecting";
    return "Approval required";
  }

  /** v16: an order of products, named by its delivery day, with order number and count. */
  private header(order: Order) {
    const earliest = order.lines.map((l) => l.claims.deliveryDate).toSorted()[0];
    const title = html`<div class="headline">
      <h2 class="name">${earliest === undefined ? "Order" : `Order for ${day(earliest)}`}</h2>
      <p>${money(order.total.net)}</p>
    </div>`;
    const facts = html`<dl class="facts">
      ${fact("Order no.", order.orderId)} ${fact("Products", String(order.lines.length))}
    </dl>`;
    const pill = order.status === "pending_approval" && !this.rejecting;
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
    return order.reasons.flatMap((r): Todo[] => {
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
          return lines
            .filter((c) => c.replaces !== null)
            .map((c) => ({
              where: c.product.name,
              target: lineId(c),
              reason: "Out of stock, a substitute is proposed",
              action: "Check the replacement",
            }));
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
          return [
            {
              where: reasonCopy(r, order, lines[0]).title,
              target: "products",
              reason: REASON_TEXT[r],
              action: "Check the products",
            },
          ];
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
    if (c.replaces !== null)
      return { text: `Substitute proposed · replaces ${c.replaces}`, warning: false };
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
    return null;
  }

  /**
   * v17 agent help: a ready prompt button and option chips. Display only for now: sending
   * the prompt to the chat (MCP Apps sendMessage) is not wired yet.
   */
  private agentHelp(label: string, chips: string[]) {
    return html`<div class="agent-help" part="agent-help">
      <button type="button" class="btn secondary">${label}</button>
      <p class="label-small secondary">Or tell it what to do:</p>
      <div class="chips">
        ${chips.map((chip) => html`<button type="button" class="chip">${chip}</button>`)}
      </div>
    </div>`;
  }

  /** The order-level agent help for the issue that applies to the whole order (v17). */
  private orderHelp(order: Order) {
    if (order.reasons.includes("SPEND_OVER_LIMIT"))
      return this.agentHelp("Let the agent reduce it", [
        "Remove the least needed",
        "Choose cheaper brands",
        "Order less of each",
      ]);
    if (order.reasons.some((r) => REQUOTE.has(r)))
      return this.agentHelp("Let the agent find a better offer", [
        "Keep the earlier delivery",
        "Find a cheaper one",
        "Remove the changed product",
      ]);
    if (order.reasons.includes("NEW_PRODUCT"))
      return html`<p class="body-small">
          Confirm the order to include the new product, or remove it with Edit products.
        </p>
        ${this.agentHelp("Let the agent find another", ["Use our usual product", "Remove it"])}`;
    return nothing;
  }

  /** The decision block of a flagged product: its choices and agent help (v17). */
  private lineDecision(order: Order, c: OfferClaims) {
    const others = order.alternatives.length;
    const otherChoices =
      others === 0
        ? nothing
        : html`<button type="button" class="more-products">
            Other choices (${others})${icon(chevronDown)}
          </button>`;
    if (c.replaces !== null)
      return html`${otherChoices}
      ${this.agentHelp("Let the agent find another", [
        "Same brand only",
        "Cheapest option",
        ...(c.nextDeliveryDate === null ? [] : [`Wait until ${day(c.nextDeliveryDate)}`]),
      ])}`;
    if (c.shortfall === null) return nothing;
    const pack = c.product.perSalesUnit;
    const later = c.nextDeliveryDate;
    const packs = (q: number) => (pack === null ? amount(c.quantity) : `${number(q)} packs`);
    const missing = pack === null ? c.shortfall.value : Math.round(c.shortfall.value / pack.value);
    return html`<h4 class="section-title">How to handle the missing ${amount(c.shortfall)}</h4>
      ${
        later === null
          ? nothing
          : html`<div class="option" part="option">
              <span class="radio" aria-hidden="true"></span>
              <div>
                <p>Split delivery</p>
                <dl class="option-facts body-small">
                  <div>
                    <dt class="label-small secondary">${day(c.deliveryDate)}</dt>
                    <dd>${packs(c.quantity.value)}</dd>
                  </div>
                  <div>
                    <dt class="label-small secondary">${day(later)}</dt>
                    <dd>${packs(missing)}</dd>
                  </div>
                </dl>
              </div>
              <span class="recommended label-small">Recommended</span>
            </div>`
      }
      ${otherChoices}
      ${this.agentHelp("Let the agent sort it out", [
        ...(later === null ? [] : [`All on ${day(later)}`]),
        `Only ${packs(c.quantity.value)}`,
        "Another product",
      ])}`;
  }

  private productLine(order: Order, c: OfferClaims, flagged: boolean) {
    const note = this.lineNote(order, c);
    const pack = c.product.perSalesUnit;
    return html`<li
      class="product ${flagged ? "flagged" : ""}"
      id="line-${c.offerId}"
      tabindex="-1"
    >
      <p class="product-top">
        <span class="product-name">${c.product.name}</span><span>${money(c.total.net)}</span>
      </p>
      <p class="product-amounts body-small">
        <span>${amount(stdUnits(c))}</span>
        ${
          pack === null
            ? nothing
            : html`<span class="secondary">${number(c.quantity.value)} × ${amount(pack)}</span>`
        }
      </p>
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
    const isFlagged = (c: OfferClaims) => pending && (c.replaces !== null || c.shortfall !== null);
    const flagged = all.filter(isFlagged);
    const ready = all.filter((c) => !isFlagged(c));
    const visible = this.allProducts ? ready : ready.slice(0, SHOWN);
    const hidden = ready.length - SHOWN;
    return html`<section part="products" id="products" tabindex="-1">
      <div class="products-head">
        <h3 class="section-title">Products</h3>
        ${
          pending
            ? html`<button type="button" class="link-button" part="edit-products">
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
    if (this.busy) return confirm ? "Confirming…" : "Approving…";
    if (order.reasons.some((r) => REQUOTE.has(r))) return "Approve new price";
    return confirm ? "Confirm order" : "Approve order";
  }

  private pendingBody(order: Order) {
    return html`${this.todoBox(order)} ${this.guidance(order)} ${this.whatChanged(order)}
      ${this.orderHelp(order)} ${this.products(order)} ${this.orderedFor(order)}
      ${this.openUntil(order)}
      <div class="actions" part="actions">
        <button
          part="button approve"
          class="btn primary"
          ?disabled=${this.busy}
          aria-busy=${this.busy ? "true" : "false"}
          @click=${() => this.decide({ decision: "approve", proposalVersion: order.proposalVersion })}
        >
          ${this.busy ? html`<span class="spinner" role="status" aria-label="Sending"></span>` : nothing}
          ${this.approveLabel(order)}
        </button>
        <button
          part="button reject"
          class="btn ghost"
          ?disabled=${this.busy}
          @click=${() => (this.rejecting = true)}
        >
          Reject
        </button>
      </div>
      <button type="button" class="btn ghost talk" part="button talk">Talk to the agent</button>`;
  }

  private rejectBody(order: Order) {
    return html`<p class="strong">
        Why are you rejecting? The agent uses this to find a better option.
      </p>
      <div class="chips" role="group" aria-label="Reason">
        ${REJECT_REASONS.map(
          (reason) =>
            html`<button
              class="chip"
              aria-pressed=${this.rejectReason === reason ? "true" : "false"}
              @click=${() => (this.rejectReason = reason)}
            >
              ${reason}
            </button>`,
        )}
      </div>
      <div>
        <label class="field-label" for="reject-note">Note to agent (optional)</label>
        <input id="reject-note" class="field" placeholder="Find a cheaper brand" />
      </div>
      <fieldset class="after-reject">
        <legend class="section-title">After rejecting</legend>
        ${AFTER_REJECT.map(
          (choice) =>
            html`<label class="choice ${this.afterReject === choice.next ? "selected" : ""}">
              <input
                type="radio"
                name="after-reject"
                .checked=${this.afterReject === choice.next}
                @change=${() => (this.afterReject = choice.next)}
              />
              <span
                ><span class="choice-label">${choice.label}</span><br /><span class="body-small"
                  >${choice.hint}</span
                ></span
              >
            </label>`,
        )}
      </fieldset>
      ${this.orderedFor(order)}
      <div class="actions">
        <button
          part="button send-back"
          class="btn primary"
          ?disabled=${this.busy}
          aria-busy=${this.busy ? "true" : "false"}
          @click=${() => this.reject(order)}
        >
          ${this.busy ? html`<span class="spinner" role="status" aria-label="Sending"></span>` : nothing}
          ${this.busy ? "Sending…" : "Send to agent"}
        </button>
        <button class="btn ghost" ?disabled=${this.busy} @click=${() => (this.rejecting = false)}>
          Cancel
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
    // The reject note is "<reason>: <note>"; split it back into the two rows of the design.
    const [reasonLabel = "", ...rest] = (decision?.note ?? "").split(": ");
    const known = REJECT_REASONS.some((r) => r === reasonLabel);
    const note = known ? rest.join(": ") : (decision?.note ?? "");
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
          : rows([
              ["Reason", known ? reasonLabel : null],
              ["Your note", note === "" ? null : `“${note}”`],
            ])
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
        : this.rejecting
          ? this.rejectBody(order)
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
