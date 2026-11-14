import type { DecideApprovalRequest, Order, PendingList } from "@app/contract";
import { brand } from "@app/ui/brand";
import { css, html, nothing } from "lit";
import {
  callAction,
  loadView,
  type ViewData,
  type ViewEntryOf,
  viewEntry,
} from "../../shared/bridge.ts";
import checkCircle from "../../shared/icons/check-circle-32.svg?raw";
import warningSmall from "../../shared/icons/warning-16.svg?raw";
import warningLarge from "../../shared/icons/warning-32.svg?raw";
import { pick } from "../../shared/locale.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { defineApprovalCard, reasonSummaries } from "./approval-card.ts";
import { CARD } from "./card-strings.ts";
import { brandHeader, cardStyles, icon, money, orderName, vat, when } from "./parts.ts";
import { VIEW } from "./strings.ts";

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
    decisionError: { state: true },
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
      .item-reasons {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        margin: 0;
        padding: 0;
        list-style: none;
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
      .updating img {
        width: 56px;
        height: auto;
        flex-shrink: 0;
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
      /* The row above the card: the back link in an order, kept empty in the list. */
      .top-row {
        display: flex;
        align-items: center;
        min-height: 2.75rem;
      }
      .back {
        padding: 0;
        border: 0;
        background: none;
        color: var(--color-link);
        font: inherit;
        font-size: var(--font-size-xs);
        font-weight: 600;
        cursor: pointer;
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
  /** Why the last decision on an order failed, shown in its card. */
  declare private decisionError: { orderId: string; message: string } | null;
  private limitAsked = false;
  /** What the tool is doing, from its arguments, while the result is on its way. */
  declare private pending: { placing: boolean; request: string | null };

  constructor() {
    super();
    this.openId = null;
    this.busyId = null;
    this.updatingId = null;
    this.orderLimit = null;
    this.decisionError = null;
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

  /**
   * Reads the order limit once, when an over-limit order is shown; without it the block shows no
   * limit. Other orders need no limit, so the host shows no tool call for them.
   */
  override updated() {
    const order = this.state.kind === "done" ? this.selectedOrder(this.state.data) : undefined;
    this.dispatchEvent(
      new CustomEvent("tt-approval-selection", { detail: order?.orderId ?? null }),
    );
    const state = this.state;
    if (this.limitAsked || this.source === null || state.kind !== "done") return;
    const orders = "orders" in state.data ? state.data.orders : [state.data];
    if (!orders.some((o) => o.reasons.includes("SPEND_OVER_LIMIT"))) return;
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
    // A failed decision keeps the card and says why there (an expired offer, a conflict …).
    if (result.kind !== "done") {
      this.decisionError = { orderId: order.orderId, message: decisionFailure(result) };
      return;
    }
    this.decisionError = null;
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
    if (updated.status !== "pending_approval") await this.tell(updated);
  }

  /**
   * The model learns the decision made on the card, with the order id, so it does not say the
   * order still waits. Only "Reject, allow alternatives" leaves the agent work to do: that one is
   * also said in the chat, which starts the agent's turn. A host that refuses it changes nothing
   * on the card; the agent reads the context with the user's next message.
   */
  private async tell(order: Order) {
    const text = decisionText(order);
    await this.source?.context?.(`${text} Order id: ${order.orderId}.`).catch(() => undefined);
    if (order.status === "declined" && order.decision?.next === "alternatives")
      await this.source?.message?.(text).catch(() => undefined);
  }

  /** Opens an order from the list (or goes back with null) at the top of the view. */
  private open(orderId: string | null) {
    this.openId = orderId;
    this.decisionError = null;
    window.scrollTo({ top: 0 });
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
        this.decisionError = { orderId: order.orderId, message: decisionFailure(rejected) };
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
        message: cause instanceof Error ? cause.message : pick(VIEW).notSent,
        plainUrl: order.approvalUrl,
      };
    }
  }

  /** Prototype P4: the collapsed card while the agent works on the order. */
  private updating(order: Order) {
    const text = pick(VIEW);
    return html`<article class="updating" part="updating" role="status">
      <img src=${brand.logo} alt=${brand.name} />
      <div class="updating-text">
        <p class="strong">${orderName(order)}</p>
        <p class="body-small">${text.agentUpdating}</p>
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
    const text = pick(VIEW);
    const title = placing ? text.checkingOrder : text.loadingApprovals;
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
          ${placing ? html`<p class="body-small secondary">${text.verifying}</p>` : nothing}
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

  private empty() {
    const text = pick(VIEW);
    return html`<article class="card" part="empty">
      ${brandHeader(text.brandApprovals(brand.name), html`<h2 class="title">${text.approvals}</h2>`)}
      <div class="body center">
        ${icon(checkCircle)}
        <p class="headline">${text.noneWaiting}</p>
        <p class="secondary">${text.newRequests}</p>
      </div>
    </article>`;
  }

  private list(orders: Order[]) {
    const pending = orders.filter((o) => o.status === "pending_approval").length;
    const text = pick(VIEW);
    return html`<div class="top-row" aria-hidden="true"></div>
      <article class="card" part="list">
        ${brandHeader(
          text.brandApprovals(brand.name),
          html`<h2 class="title">${pending === 0 ? text.approvals : text.waiting(pending)}</h2>`,
        )}
        <div class="body">
          <ul class="list">
            ${orders.map((order) => {
              const claims = order.lines.map((l) => l.claims);
              const decideBy = Math.min(...claims.map((c) => c.exp));
              return html`<li class="item">
                <p class="item-name">
                  <span class="name">${orderName(order)}</span
                  ><span>${money(order.total.net)} ${vat("net")}</span>
                </p>
                <ul class="item-reasons body-small">
                  ${reasonSummaries(order).map(
                    (reason) => html`<li class="item-reason">${icon(warningSmall)}${reason}</li>`,
                  )}
                </ul>
                <dl class="item-facts body-small">
                  <div>
                    <dt class="label-small">${text.products}</dt>
                    <dd>${claims.length}</dd>
                  </div>
                  ${
                    Number.isFinite(decideBy)
                      ? html`<div>
                          <dt class="label-small">${text.decideBy}</dt>
                          <dd>${when(new Date(decideBy * 1000))}</dd>
                        </div>`
                      : nothing
                  }
                </dl>
                <button class="btn secondary" @click=${() => this.open(order.orderId)}>
                  ${text.review}
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
    if (state.kind === "error") return errorCard(state.plainUrl, () => this.reload());
    if (state.kind === "empty") return this.empty();
    return this.renderDone(state.data);
  }

  private selectedOrder(data: ViewData<"approval-card">) {
    const orders = "orders" in data ? data.orders : [data];
    return orders.length === 1 ? orders[0] : orders.find((o) => o.orderId === this.openId);
  }

  protected override renderDone(data: ViewData<"approval-card">) {
    const orders = "orders" in data ? data.orders : [data];
    const open = this.selectedOrder(data);
    if (open === undefined) return orders.length === 0 ? this.empty() : this.list(orders);
    if (this.updatingId === open.orderId) return this.updating(open);
    // The back link sits in a row the list keeps too, so the card does not move.
    return html`${
        orders.length > 1
          ? html`<div class="top-row">
              <button class="back" @click=${() => this.open(null)}>
                ${pick(VIEW).allApprovals}
              </button>
            </div>`
          : nothing
      }
      <tt-approval-card
        .order=${open}
        ?busy=${this.busyId === open.orderId}
        ?can-ask=${this.source?.message !== undefined}
        .orderLimit=${this.orderLimit}
        .error=${this.decisionError?.orderId === open.orderId ? this.decisionError.message : null}
        @tt-decide=${(e: CustomEvent<DecideApprovalRequest>) => this.decide(open, e.detail)}
        @tt-confirm-changes=${(e: CustomEvent<DecideApprovalRequest>) =>
          this.decide(open, e.detail, true)}
        @tt-ask-agent=${(e: CustomEvent<string>) => this.ask(open, e.detail, true)}
        @tt-talk=${(e: CustomEvent<string>) => this.ask(open, e.detail, false)}
      ></tt-approval-card>`;
  }
}

/** Plain words for a failed decision, by the server's error code ("CODE: message"). */
const decisionFailure = (result: { kind: string; message?: string }) => {
  const text = pick(VIEW);
  const code = /^([A-Z_]+):/.exec(result.message ?? "")?.[1];
  return (code === undefined ? undefined : text.failures[code]) ?? text.notSaved;
};

/** The decision made on the card and what the agent does next, in the approver's words, without ids. */
export const decisionText = (order: Order) => {
  const name = orderName(order);
  const decided = pick(VIEW).decided;
  if (order.status === "placed") return decided.placed(name, brand.name);
  if (order.status === "awaiting_payment") return decided.awaitingPayment(name, brand.name);
  if (order.status === "rejected")
    return decided.notPlaced(name, order.reasons.map((r) => pick(CARD).reason[r]).join(" "));
  return order.decision?.next === "alternatives" ? decided.alternatives(name) : decided.stop(name);
};

/** The error state: the approval page when there is one, and Try again. */
export const errorCard = (approvalUrl: string | null, retry: () => void) => {
  const text = pick(VIEW);
  return html`<article class="card" part="error" role="alert">
    ${brandHeader(text.brandApprovals(brand.name))}
    <div class="body center">
      ${icon(warningLarge)}
      <p class="headline">${text.cantShowTitle}</p>
      <p class="secondary">${approvalUrl === null ? text.cantShowRetry : text.cantShowBody}</p>
      <div class="actions">
        ${
          approvalUrl === null
            ? nothing
            : html`<a class="btn primary" href=${approvalUrl} target="_blank" rel="noreferrer"
                >${text.openApprovalPage}</a
              >`
        }
        <button class="btn ghost" @click=${retry}>${text.tryAgain}</button>
      </div>
      ${approvalUrl === null ? nothing : html`<p class="label-small secondary">${text.opensNewTab}</p>`}
    </div>
  </article>`;
};

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
