import type { DecideApprovalRequest, Order, PendingList } from "@app/contract";
import { css, html, nothing } from "lit";
import {
  callAction,
  loadView,
  type ViewData,
  type ViewEntryOf,
  viewEntry,
} from "../../shared/bridge.ts";
import checkCircle from "../../shared/icons/check-circle-32.svg?raw";
import logo from "../../shared/icons/logo-valio-aimo.svg?raw";
import warningSmall from "../../shared/icons/warning-16.svg?raw";
import warningLarge from "../../shared/icons/warning-32.svg?raw";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { defineApprovalCard, reasonTitle } from "./approval-card.ts";
import { amount, brandHeader, cardStyles, day, icon, money, stdUnits, timeOnly } from "./parts.ts";

/**
 * Loads the tool result from `source` and shows each view state: loading, error, the empty
 * list, the list of pending orders, or one order card. Sends decisions back through `source`.
 */
class ApprovalView extends ViewElement<ViewEntryOf<"approval-card">> {
  // No decorators: browsers and the bundler do not transform them yet.
  static override properties = {
    ...ViewElement.properties,
    openId: { state: true },
    busyId: { state: true },
    updatingId: { state: true },
    orderLimit: { state: true },
    pending: { state: true },
  };

  static override styles = [
    base,
    cardStyles,
    css`
      .skeleton {
        display: block;
        height: 14px;
      }
      .loading-text {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }
      .header .skeleton {
        --shimmer-base: color-mix(in srgb, var(--color-text-on-brand) 18%, transparent);
        --shimmer-sweep: color-mix(in srgb, var(--color-silver) 40%, transparent);
        --shimmer-edge: color-mix(in srgb, var(--color-pink-soft) 25%, transparent);
        height: 18px;
      }
      .w-60 {
        width: 60%;
      }
      .w-45 {
        width: 45%;
      }
      .w-80 {
        width: 80%;
      }
      .w-75 {
        width: 75%;
      }
      .skeleton.button {
        width: 160px;
        height: 36px;
      }
      .skeleton.button.small {
        width: 96px;
      }
      .center {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-md);
        text-align: center;
      }
      .center .headline {
        font-size: var(--font-size-xl);
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: 0;
        list-style: none;
      }
      .item {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        padding: var(--spacing-lg);
        border: 1px solid var(--color-border);
        border-radius: 0;
      }
      .item-reason {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        color: var(--color-text-warning);
      }
      .item-name {
        display: flex;
        gap: var(--spacing-lg);
      }
      .item-name .name {
        flex: 1;
        color: var(--color-heading);
      }
      .item-facts {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs) var(--spacing-xl);
      }
      .item-facts dt {
        color: var(--color-text-secondary);
      }
      .item .btn {
        align-self: flex-start;
      }
      a.btn {
        text-decoration: none;
      }
      .updating {
        position: relative;
        display: flex;
        align-items: center;
        gap: var(--spacing-lg);
        padding: var(--spacing-lg) var(--spacing-xl);
        background: var(--color-bg-brand);
        color: var(--color-text-on-brand);
      }
      .updating-text {
        flex: 1;
      }
      .strip-bar {
        position: absolute;
        right: 0;
        bottom: 0;
        left: 0;
      }
      .back {
        margin-bottom: var(--spacing-sm);
        padding-left: 0;
      }
      @container (min-width: 760px) {
        .item {
          display: grid;
          grid-template-columns: 1fr auto;
          align-items: center;
        }
        .item .btn {
          grid-column: 2;
          grid-row: 1 / span 3;
          align-self: center;
        }
      }
    `,
  ];

  readonly entry = viewEntry("approval-card");
  declare private openId: string | null;
  declare private busyId: string | null;
  /** The order the agent is updating after a message (prototype P4). */
  declare private updatingId: string | null;
  /** The mandate's order limit (gross EUR) for the Order total block; null when unknown. */
  declare private orderLimit: number | null;
  private limitAsked = false;
  /** What the tool is doing, from its arguments, while the result is on its way. */
  declare private pending: { placing: boolean; request: string | null };

  constructor() {
    super();
    this.openId = null;
    this.busyId = null;
    this.updatingId = null;
    this.orderLimit = null;
    this.pending = { placing: false, request: null };
  }

  override connectedCallback() {
    super.connectedCallback();
    void this.source?.input?.then((args) => {
      this.pending = {
        placing: Array.isArray(args["offers"]),
        request: typeof args["originalRequest"] === "string" ? args["originalRequest"] : null,
      };
    });
  }

  /** Reads the order limit once, when the first order is shown; without it the block shows no limit. */
  override updated() {
    if (this.limitAsked || this.source === null || this.state.kind !== "done") return;
    this.limitAsked = true;
    void callAction(this.source, "get_mandate", {}, null).then((result) => {
      if (result.kind === "done" && result.data.status === "active")
        this.orderLimit = result.data.mandate.limits.maxOrderTotal.value;
    });
  }

  private reload() {
    if (this.source === null) return;
    this.state = { kind: "loading" };
    void loadView(this.entry, this.source).then((state) => (this.state = state));
  }

  /**
   * Sends a decision. With `thenApprove` (Confirm after changing amounts) the edit's new quote
   * is approved at once, unless it brings a reason the order did not have: then it is shown.
   */
  private async decide(order: Order, request: DecideApprovalRequest, thenApprove = false) {
    if (this.source === null) return;
    this.busyId = order.orderId;
    const result = await callAction(
      this.source,
      "decide_approval",
      { orderId: order.orderId, ...request },
      order.approvalUrl,
    );
    this.busyId = null;
    if (result.kind !== "done") {
      this.state = result;
      return;
    }
    const state = this.state;
    if (state.kind === "done")
      this.state = { kind: "done", data: replace(state.data, result.data) };
    const updated = result.data;
    if (
      thenApprove &&
      updated.status === "pending_approval" &&
      updated.reasons.every((r) => order.reasons.includes(r))
    )
      await this.decide(updated, { decision: "approve", proposalVersion: updated.proposalVersion });
    // The model learns the decision made on the card, so it does not say the order still waits.
    if (updated.status !== "pending_approval") void this.source.context?.(decisionContext(updated));
  }

  /**
   * Sends the card's message to the agent in the chat. With `update` (agent help) the order is
   * rejected first, with `next: "alternatives"` and the prompt as its note, so only the agent's
   * new offer stays open; the card then waits for it. A failed rejection sends nothing.
   */
  private async ask(order: Order, text: string, update: boolean) {
    const source = this.source;
    const message = source?.message;
    if (source === null || message === undefined) return;
    if (update) {
      this.updatingId = order.orderId;
      const rejected = await callAction(
        source,
        "decide_approval",
        {
          orderId: order.orderId,
          proposalVersion: order.proposalVersion,
          decision: "reject",
          next: "alternatives",
          note: text,
        },
        order.approvalUrl,
      );
      if (rejected.kind !== "done") {
        this.updatingId = null;
        this.state = rejected;
        return;
      }
      void source.context?.(
        `Order ${order.orderId} was rejected on the approval card because the approver asked for a new offer. Place the new order for approval when you have it.`,
      );
    }
    try {
      await message(text);
    } catch (cause) {
      this.updatingId = null;
      this.state = {
        kind: "error",
        message: cause instanceof Error ? cause.message : "The message was not sent.",
        plainUrl: order.approvalUrl,
      };
    }
  }

  /** Prototype P4: the collapsed card while the agent works on the order. */
  private updating(order: Order) {
    const earliest = order.lines.map((l) => l.claims.deliveryDate).toSorted()[0];
    return html`<article class="updating" part="updating" role="status">
      ${icon(logo, "Valio Aimo")}
      <div class="updating-text">
        <p class="strong">${earliest === undefined ? "Order" : `Order for ${day(earliest)}`}</p>
        <p class="body-small">The agent is updating this order</p>
      </div>
      <span class="shimmer load-bar strip-bar" aria-hidden="true"></span>
    </article>`;
  }

  /**
   * While the tool runs: what it is doing (from its arguments when the host sends them) and
   * shimmering placeholders. The server reports no steps, so this names them.
   */
  private loading() {
    const { placing, request } = this.pending;
    const title = placing ? "Checking your order…" : "Loading approvals…";
    return html`<article class="card" part="loading" aria-busy="true">
      ${brandHeader(
        title,
        html`<span class="skeleton shimmer w-60" aria-hidden="true"></span>`,
        html`<span class="skeleton shimmer w-45" aria-hidden="true"></span>`,
      )}
      <span class="shimmer load-bar" aria-hidden="true"></span>
      <div class="body">
        <div class="loading-text" role="status">
          <p class="strong">${title}</p>
          ${
            placing
              ? html`<p class="body-small secondary">
                  Verifying the signed offers and checking them against your limits.
                </p>`
              : nothing
          }
          ${request === null ? nothing : html`<p class="body-small">“${request}”</p>`}
        </div>
        <span class="skeleton shimmer w-80" aria-hidden="true"></span
        ><span class="skeleton shimmer w-60" aria-hidden="true"></span
        ><span class="skeleton shimmer w-75" aria-hidden="true"></span>
        <div class="actions">
          <span class="skeleton shimmer button" aria-hidden="true"></span
          ><span class="skeleton shimmer button small" aria-hidden="true"></span>
        </div>
      </div>
    </article>`;
  }

  private error(approvalUrl: string | null) {
    return html`<article class="card" part="error" role="alert">
      ${brandHeader("Valio Aimo approvals")}
      <div class="body center">
        ${icon(warningLarge)}
        <p class="headline">This approval can't be shown here</p>
        <p class="secondary">Open it on the approval page to review and decide.</p>
        <div class="actions">
          ${
            approvalUrl === null
              ? nothing
              : html`<a class="btn primary" href=${approvalUrl} target="_blank" rel="noreferrer"
                  >Open approval page</a
                >`
          }
          <button class="btn ghost" @click=${() => this.reload()}>Try again</button>
        </div>
        ${approvalUrl === null ? nothing : html`<p class="label-small secondary">Opens in a new tab</p>`}
      </div>
    </article>`;
  }

  private empty() {
    return html`<article class="card" part="empty">
      ${brandHeader("Valio Aimo approvals", html`<h2 class="title">Approvals</h2>`)}
      <div class="body center">
        ${icon(checkCircle)}
        <p class="headline">No orders wait for approval</p>
        <p class="secondary">New requests from the agent show up here.</p>
      </div>
    </article>`;
  }

  private list(orders: Order[]) {
    const pending = orders.filter((o) => o.status === "pending_approval").length;
    return html`<article class="card" part="list">
      ${brandHeader(
        "Valio Aimo approvals",
        html`<h2 class="title">
          ${pending === 0 ? "Approvals" : `${pending} order${pending === 1 ? "" : "s"} wait for approval`}
        </h2>`,
      )}
      <div class="body">
        <ul class="list">
          ${orders.map((order) => {
            const claims = order.lines[0]?.claims;
            return html`<li class="item">
              <p class="item-reason body-small strong">
                ${icon(warningSmall)}${reasonTitle(order)}
              </p>
              <p class="item-name">
                <span class="name"
                  >${
                    order.lines.length === 1 && claims !== undefined
                      ? claims.product.name
                      : `Order of ${order.lines.length} products`
                  }</span
                ><span>${money(order.total.net)}</span>
              </p>
              ${
                claims === undefined
                  ? nothing
                  : html`<dl class="item-facts body-small">
                      <div>
                        <dt class="label-small">Quantity</dt>
                        <dd>${amount(stdUnits(claims))}</dd>
                      </div>
                      <div>
                        <dt class="label-small">Delivery</dt>
                        <dd>${day(claims.deliveryDate)}</dd>
                      </div>
                      <div>
                        <dt class="label-small">Valid until</dt>
                        <dd>${timeOnly(new Date(claims.exp * 1000))}</dd>
                      </div>
                    </dl>`
              }
              <button class="btn secondary" @click=${() => (this.openId = order.orderId)}>
                Review
              </button>
            </li>`;
          })}
        </ul>
      </div>
    </article>`;
  }

  override render() {
    const state = this.state;
    if (state.kind === "loading") return this.loading();
    if (state.kind === "error") return this.error(state.plainUrl);
    if (state.kind === "empty") return this.empty();
    return this.renderDone(state.data);
  }

  protected override renderDone(data: ViewData<"approval-card">) {
    const orders = "orders" in data ? data.orders : [data];
    const open = orders.length === 1 ? orders[0] : orders.find((o) => o.orderId === this.openId);
    if (open === undefined) return orders.length === 0 ? this.empty() : this.list(orders);
    if (this.updatingId === open.orderId) return this.updating(open);
    return html`${
        orders.length > 1
          ? html`<button class="btn ghost back" @click=${() => (this.openId = null)}>
              ← All approvals
            </button>`
          : nothing
      }
      <tt-approval-card
        .order=${open}
        ?busy=${this.busyId === open.orderId}
        ?can-ask=${this.source?.message !== undefined}
        .orderLimit=${this.orderLimit}
        @tt-decide=${(e: CustomEvent<DecideApprovalRequest>) => this.decide(open, e.detail)}
        @tt-confirm-changes=${(e: CustomEvent<DecideApprovalRequest>) =>
          this.decide(open, e.detail, true)}
        @tt-ask-agent=${(e: CustomEvent<string>) => this.ask(open, e.detail, true)}
        @tt-talk=${(e: CustomEvent<string>) => this.ask(open, e.detail, false)}
      ></tt-approval-card>`;
  }
}

/** What the model is told after a decision on the card. */
const decisionContext = (order: Order) =>
  order.status === "placed" || order.status === "awaiting_payment"
    ? `The approver confirmed order ${order.orderId} on the approval card. It was sent to Valio Aimo.`
    : `The approver rejected order ${order.orderId} on the approval card. Nothing is ordered. Do not ask for its approval again unless the user asks for a new order.`;

/** Puts a decided order back into the tool result it came from. */
const replace = (data: Order | PendingList, updated: Order) =>
  "orders" in data
    ? { orders: data.orders.map((o) => (o.orderId === updated.orderId ? updated : o)) }
    : updated;

/** Registers `<tt-approval-view>` and the card it renders; safe to call more than once. */
export function defineApprovalView() {
  defineApprovalCard();
  defineView("tt-approval-view", ApprovalView);
}

declare global {
  interface HTMLElementTagNameMap {
    "tt-approval-view": ApprovalView;
  }
}
