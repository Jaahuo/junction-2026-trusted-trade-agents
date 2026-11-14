import {
  type DecideApprovalRequest,
  type OfferClaims,
  type Order,
  REASON_TEXT,
  type ReasonCode,
} from "@app/contract";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import checkCircle from "../../shared/icons/check-circle.svg?raw";
import chevronDown from "../../shared/icons/chevron-down.svg?raw";
import clockIcon from "../../shared/icons/clock.svg?raw";
import search from "../../shared/icons/search.svg?raw";
import warning from "../../shared/icons/warning.svg?raw";
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
  price,
  rows,
  stdUnits,
  unit,
  when,
} from "./parts.ts";

// Figma: Junction 2026 › Screens › "Approval request — v8". Single column (chat) below
// 760px, two columns (desktop) from 760px. Fields the order does not carry (order limit,
// kitchen, on behalf of, choice) follow the "no limit, kitchen or on behalf of" variants.

type Reason = { title: string; detail: string | null };

/** Headline and one-line explanation per reason, from the v8 copy list. */
function reasonCopy(code: ReasonCode, order: Order, claims: OfferClaims | undefined): Reason {
  const p = claims?.product;
  switch (code) {
    case "SPEND_OVER_LIMIT":
      return { title: "Over your order limit", detail: "Above the agent's spending limit." };
    case "NEW_PRODUCT":
      return {
        title: "New product",
        detail: `${order.customer} has not ordered this product before.`,
      };
    case "CATEGORY_NOT_ALLOWED":
      return {
        title: "Category not allowed",
        detail: p === undefined ? null : `${p.category} is outside the agent's allowed categories.`,
      };
    case "RELIABILITY_BELOW_MIN":
      return {
        title: "Delivery reliability below minimum",
        detail:
          p?.deliveryReliability == null
            ? null
            : `On-time delivery ${Math.round(p.deliveryReliability * 100)}%.`,
      };
    case "CO2_ABOVE_MAX":
      return {
        title: "CO₂ above maximum",
        detail: p?.co2PerKg == null ? null : `${number(p.co2PerKg)} kg CO₂e per kg.`,
      };
    case "UNCONFIRMED_ALLERGEN":
      return {
        title: "Allergen information not confirmed",
        detail: "Allergens for this product are not confirmed.",
      };
    case "UNCONFIRMED_STOCK":
      return {
        title: "Stock not confirmed",
        detail:
          claims === undefined ? null : `Stock for ${day(claims.deliveryDate)} is not confirmed.`,
      };
    case "QUANTITY_UNUSUAL":
      return { title: "Unusually large quantity", detail: null };
    case "PAYMENT_TERMS":
      return {
        title: "Payment terms need approval",
        detail: order.paymentTerms === "pay_on_order" ? "Prepayment instead of invoice." : null,
      };
    case "SUBSTITUTION":
      return { title: "The requested product is out of stock", detail: REASON_TEXT[code] };
    case "PRICE_CHANGED":
      return { title: "Price changed since the offer", detail: null };
    case "AVAILABILITY_DIFFERS":
      return { title: "Delivery changed since the offer", detail: null };
    default:
      return { title: REASON_TEXT[code], detail: null };
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

/** Reject reasons from the design; "Not needed" stops the agent, the others let it look further. */
const REJECT_REASONS = [
  { label: "Too expensive", next: "alternatives" },
  { label: "Wrong product", next: "alternatives" },
  { label: "Not needed", next: "stop" },
  { label: "Other", next: "alternatives" },
] as const;

const REQUOTE: ReadonlySet<ReasonCode> = new Set(["PRICE_CHANGED", "AVAILABILITY_DIFFERS"]);
const isApproved = (o: Order) => o.status === "placed" || o.status === "awaiting_payment";

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
    detailsOpen: { state: true },
  };

  static override styles = [
    base,
    cardStyles,
    css`
      .columns {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
      }
      .reason-headline {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        color: var(--color-text-warning);
        font-weight: 600;
      }
      .reason {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }
      .reason-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: 0;
        list-style: none;
      }
      .reason-list li {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--spacing-2xs) var(--spacing-sm);
        align-items: center;
      }
      .reason-list .detail {
        grid-column: 2;
      }
      .compare {
        display: grid;
        grid-template-columns: 40px 1fr auto;
        gap: var(--spacing-sm) var(--spacing-md);
        align-items: center;
        padding: var(--spacing-lg);
        border-radius: var(--border-radius-md);
        background: var(--color-bg-brand-subtle);
      }
      .compare.two {
        grid-template-columns: 40px 1fr 1fr;
      }
      .compare .was {
        color: var(--color-text-secondary);
      }
      .compare .now-label {
        color: var(--color-heading);
      }
      .compare .num {
        text-align: right;
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        grid-column: 1 / -1;
        gap: var(--spacing-sm);
      }
      .badge {
        padding: var(--spacing-2xs) var(--spacing-sm);
        border-radius: var(--radius-full);
        background: var(--color-bg-warning);
        color: var(--color-text-warning);
      }
      .lines {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: 0;
        list-style: none;
      }
      .lines li {
        display: flex;
        justify-content: space-between;
        gap: var(--spacing-lg);
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
        border-radius: var(--border-radius-md);
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
      /* v8 "Sending": the busy primary button stays solid; only the others fade. */
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
        font: inherit;
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
      @container (min-width: 760px) {
        .columns {
          grid-template-columns: 520px minmax(0, 1fr);
        }
        .details {
          border-top: 0;
          border-left: 1px solid var(--color-border);
        }
        .toggle {
          display: none;
        }
        .details-body {
          display: flex;
          padding: var(--spacing-xl);
        }
      }
    `,
  ];

  declare order: Order | null;
  declare busy: boolean;
  declare private rejecting: boolean;
  declare private rejectReason: (typeof REJECT_REASONS)[number] | null;
  declare private detailsOpen: boolean;

  constructor() {
    super();
    this.order = null;
    this.busy = false;
    this.rejecting = false;
    this.rejectReason = null;
    this.detailsOpen = false;
  }

  private decide(request: DecideApprovalRequest) {
    this.dispatchEvent(
      new CustomEvent("tt-decide", { detail: request, bubbles: true, composed: true }),
    );
  }

  private reject(order: Order) {
    const field = this.renderRoot.querySelector<HTMLInputElement>("#reject-note");
    const note = [this.rejectReason?.label, field?.value.trim()].filter(Boolean).join(": ");
    this.decide({
      decision: "reject",
      next: this.rejectReason?.next ?? "alternatives",
      proposalVersion: order.proposalVersion,
      ...(note === "" ? {} : { note }),
    });
  }

  private eyebrow(order: Order) {
    if (order.status === "placed") return "Approved";
    if (order.status === "awaiting_payment") return "Approved · waiting for payment";
    if (order.status !== "pending_approval") return "Rejected";
    if (this.rejecting) return "Rejecting";
    if (order.reasons.includes("SUBSTITUTION")) return "Substitute needs your approval";
    if (order.reasons.some((r) => REQUOTE.has(r))) return "Offer changed · needs your approval";
    return "Needs your approval";
  }

  private header(order: Order) {
    const first = order.lines[0]?.claims;
    const single = order.lines.length === 1 && first !== undefined;
    const title = html`<div class="headline">
      <h2 class="name">
        ${single ? first.product.name : `Order of ${order.lines.length} products`}
      </h2>
      <p>${money(order.total.net)}</p>
    </div>`;
    if (first === undefined) return brandHeader(this.eyebrow(order), title);
    const std = stdUnits(first);
    const pack = first.product.perSalesUnit;
    const earliest =
      order.lines.map((l) => l.claims.deliveryDate).toSorted()[0] ?? first.deliveryDate;
    const facts = !single
      ? html`${fact("Products", String(order.lines.length))} ${fact("Delivery", day(earliest))}`
      : order.reasons.includes("SUBSTITUTION")
        ? html`${fact("Quantity", amount(std))}
          ${fact("Unit price", `${price(first.total.net / std.value)} / ${unit(std.unit)}`)}
          ${fact("Delivery", day(first.deliveryDate))}`
        : html`${fact("Quantity", amount(std))}
          ${pack === null ? nothing : fact("Packs", `${number(first.quantity.value)} × ${amount(pack)}`)}
          ${fact("Delivery", day(first.deliveryDate))}`;
    return brandHeader(this.eyebrow(order), title, html`<dl class="facts">${facts}</dl>`);
  }

  private requoteBlock(order: Order) {
    const last = order.requotes.at(-1);
    if (last === undefined) return nothing;
    const before = last.previous;
    const now = last.current;
    const diff = now.total.net - before.total.net;
    const days = Math.round(
      (new Date(now.deliveryDate).getTime() - new Date(before.deliveryDate).getTime()) / 86_400_000,
    );
    const pct = before.total.net === 0 ? 0 : Math.round((diff / before.total.net) * 100);
    return html`<div class="compare two">
        <span></span><span class="label-small secondary">Total</span
        ><span class="label-small secondary">Delivery</span> <span class="label-small was">Was</span
        ><span class="was">${money(before.total.net)}</span
        ><span class="was">${day(before.deliveryDate)}</span>
        <span class="label-small now-label">Now</span
        ><span class="strong">${money(now.total.net)}</span
        ><span class="strong">${day(now.deliveryDate)}</span>
        <div class="badges label-small">
          ${
            diff === 0
              ? nothing
              : html`<span class="badge"
                  >${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}
                  (${diff > 0 ? "+" : ""}${pct}%)</span
                >`
          }
          ${
            days === 0
              ? nothing
              : html`<span class="badge"
                  >${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}
                  ${days > 0 ? "later" : "earlier"}</span
                >`
          }
        </div>
      </div>
      ${
        before.offerId === now.offerId
          ? nothing
          : html`<p class="body-small">New offer ${now.offerId} replaces ${before.offerId}.</p>`
      }`;
  }

  private substitutionBlock(claims: OfferClaims) {
    if (claims.replaces === null) return nothing;
    const std = stdUnits(claims);
    return html`<div class="compare">
      <span></span><span class="label-small secondary">Product</span
      ><span class="label-small secondary num">Price / ${unit(std.unit)}</span>
      <span class="label-small was">Was</span><span class="was">${claims.replaces}</span
      ><span></span> <span class="label-small now-label">Now</span
      ><span class="strong">${claims.product.name}</span
      ><span class="strong num">${price(claims.total.net / std.value)}</span>
      ${
        claims.shortfall === null
          ? nothing
          : html`<div class="badges label-small">
              <span class="badge">${amount(claims.shortfall)} short</span>
            </div>`
      }
    </div>`;
  }

  private requoteTitle(order: Order): Reason {
    const changedPrice = order.reasons.includes("PRICE_CHANGED");
    const changedDelivery = order.reasons.includes("AVAILABILITY_DIFFERS");
    return {
      title:
        changedPrice && changedDelivery
          ? "Price and delivery changed since the offer"
          : changedDelivery
            ? "Delivery changed since the offer"
            : "Price changed since the offer",
      detail: null,
    };
  }

  private reasons(order: Order) {
    const claims = order.lines[0]?.claims;
    const codes = order.reasons.filter((r) => !REQUOTE.has(r));
    const requoted = order.reasons.some((r) => REQUOTE.has(r));
    const items: Reason[] = [
      ...(requoted ? [this.requoteTitle(order)] : []),
      ...codes.map((c) => reasonCopy(c, order, claims)),
    ];
    const only = items[0];
    if (only === undefined) return nothing;
    if (items.length > 1)
      return html`<div class="reason" part="reason">
        <p class="strong">${items.length} reasons need your approval</p>
        <ul class="reason-list">
          ${items.map(
            (r) =>
              html`<li>
                ${icon(warning)}<span class="strong">${r.title}</span>
                ${
                  r.detail === null
                    ? nothing
                    : html`<span class="detail body-small secondary">${r.detail}</span>`
                }
              </li>`,
          )}
        </ul>
      </div>`;
    const body: TemplateResult | typeof nothing = requoted
      ? this.requoteBlock(order)
      : codes[0] === "SUBSTITUTION" && claims !== undefined
        ? this.substitutionBlock(claims)
        : codes[0] === "SPEND_OVER_LIMIT"
          ? html`<p>This order is above the agent's spending limit, so it needs your approval.</p>`
          : only.detail === null
            ? nothing
            : html`<p>${only.detail}</p>`;
    return html`<div class="reason" part="reason">
      <p class="reason-headline">${icon(warning)}${only.title}</p>
      ${body}
    </div>`;
  }

  private orderLines(order: Order) {
    if (order.lines.length < 2) return nothing;
    return html`<div class="group">
      <h3 class="label-small secondary">Order lines</h3>
      <ul class="lines">
        ${order.lines.map(
          ({ claims }) =>
            html`<li>
              <div>
                <p class="strong">${claims.product.name}</p>
                <p class="body-small secondary">
                  ${
                    claims.product.perSalesUnit === null
                      ? amount(claims.quantity)
                      : `${number(claims.quantity.value)} × ${amount(claims.product.perSalesUnit)}`
                  }
                </p>
              </div>
              <p class="strong">${price(claims.total.net)}</p>
            </li>`,
        )}
      </ul>
    </div>`;
  }

  private approveLabel(order: Order) {
    if (this.busy) return "Approving…";
    const [only, ...more] = order.reasons;
    if (order.reasons.some((r) => REQUOTE.has(r))) return "Approve new price";
    if (more.length === 0 && only === "SUBSTITUTION") return "Use substitute";
    if (more.length === 0 && only === "NEW_PRODUCT") return "Approve new product";
    return `Approve ${money(order.total.net)} order`;
  }

  private pendingBody(order: Order) {
    return html`${this.reasons(order)} ${this.orderLines(order)}
      ${rows([["Customer", order.customer]])}
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
      </div>`;
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
              ${reason.label}
            </button>`,
        )}
      </div>
      <div>
        <label class="field-label" for="reject-note">Note to agent (optional)</label>
        <input id="reject-note" class="field" placeholder="Find a cheaper brand" />
      </div>
      ${rows([["Customer", order.customer]])}
      <div class="actions">
        <button
          part="button send-back"
          class="btn primary"
          ?disabled=${this.busy}
          aria-busy=${this.busy ? "true" : "false"}
          @click=${() => this.reject(order)}
        >
          ${this.busy ? html`<span class="spinner" role="status" aria-label="Sending"></span>` : nothing}
          ${this.busy ? "Sending…" : "Send back to agent"}
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
    const claims = order.lines[0]?.claims;
    const delivery = claims === undefined ? "" : ` Delivery ${day(claims.deliveryDate)}.`;
    const result =
      order.status === "placed"
        ? {
            tone: "success",
            svg: checkCircle,
            title: "Order sent to the wholesaler",
            text: `Valio Aimo has received the order.${delivery}`,
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
    const known = REJECT_REASONS.some((r) => r.label === reasonLabel);
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
          ? rows([
              ["Approved by", by],
              ["Payment", order.status === "awaiting_payment" ? "Prepayment" : null],
            ])
          : rows([
              ["Reason", known ? reasonLabel : null],
              ["Your note", note === "" ? null : `“${note}”`],
              ["Rejected by", by],
            ])
      }
      ${rows([["Customer", order.customer]])}`;
  }

  private details(order: Order) {
    const claims = order.lines[0]?.claims;
    const pending = order.status === "pending_approval";
    const verified = order.audit.some((e) => e.event === "offer_verified");
    const alternatives = order.alternatives.length;
    const replaced = order.requotes.at(-1)?.previous.offerId;
    return html`<aside class="details" part="details">
      <button
        class="toggle body-small"
        aria-expanded=${this.detailsOpen ? "true" : "false"}
        aria-controls="details-body"
        @click=${() => (this.detailsOpen = !this.detailsOpen)}
      >
        <span class="more">More details</span>${icon(chevronDown)}
        <span class="hint"
          >${pending ? "Why this option, offer and signature" : "Order, offer and signature"}</span
        >
      </button>
      <div id="details-body" class="details-body ${this.detailsOpen ? "open" : ""}">
        <div class="group">
          <h3 class="body-small strong">Why this option</h3>
          ${rows([
            ["Request", order.originalRequest === null ? null : `“${order.originalRequest}”`],
            [
              "Alternatives",
              alternatives === 0
                ? "None offered"
                : `${alternatives} more option${alternatives === 1 ? "" : "s"}`,
            ],
          ])}
        </div>
        <div class="group">
          <h3 class="body-small strong">Request</h3>
          ${rows([
            ["Requested by", order.agentId],
            ["Offer ID", order.offerIds.join(", ")],
            [
              "Replaces",
              replaced !== undefined && !order.offerIds.includes(replaced) ? replaced : null,
            ],
            ["Signature", verified ? "✓ Verified" : null],
            ["Requested at", when(new Date(order.createdAt))],
            pending
              ? ["Valid until", claims === undefined ? null : when(new Date(claims.exp * 1000))]
              : ["Decided at", order.decision === null ? null : when(new Date(order.decision.at))],
          ])}
          ${
            pending && order.approvalUrl !== null
              ? html`<a
                  class="body-small"
                  part="approval-link"
                  href=${order.approvalUrl}
                  target="_blank"
                  rel="noreferrer"
                  >Open the approval page</a
                >`
              : nothing
          }
        </div>
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
      <div class="columns">
        <div>
          ${this.header(order)}
          <div class="body">${body}</div>
        </div>
        ${this.details(order)}
      </div>
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
