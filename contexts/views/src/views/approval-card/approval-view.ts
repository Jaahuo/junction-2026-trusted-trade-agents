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
import loadingIcon from "../../shared/icons/loading.svg?raw";
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
  };

  static override styles = [
    base,
    cardStyles,
    css`
      .title {
        font-size: var(--font-size-xl);
        font-weight: 800;
        line-height: 1.083;
        letter-spacing: -0.25px;
      }
      .skeleton {
        display: block;
        height: 14px;
        border-radius: var(--border-radius-md);
        background: var(--color-bg-subtle);
      }
      .header .skeleton {
        height: 18px;
        background: color-mix(in srgb, var(--color-text-on-brand) 25%, transparent);
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
      .loading-title {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }
      .loading-title .icon {
        animation: spin 1s linear infinite;
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
        font-weight: 600;
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
        border-radius: var(--border-radius-md);
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

  constructor() {
    super();
    this.openId = null;
    this.busyId = null;
  }

  private reload() {
    if (this.source === null) return;
    this.state = { kind: "loading" };
    void loadView(this.entry, this.source).then((state) => (this.state = state));
  }

  private async decide(order: Order, request: DecideApprovalRequest) {
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
  }

  private loading() {
    return html`<article class="card" part="loading" aria-busy="true">
      ${brandHeader(
        "Loading approval…",
        html`<span class="skeleton w-60"></span>`,
        html`<span class="skeleton w-45"></span>`,
      )}
      <div class="body">
        <p class="loading-title strong" role="status">${icon(loadingIcon)} Loading approval…</p>
        <span class="skeleton w-80"></span><span class="skeleton w-60"></span
        ><span class="skeleton w-75"></span>
        <div class="actions">
          <span class="skeleton button"></span><span class="skeleton button small"></span>
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
        @tt-decide=${(e: CustomEvent<DecideApprovalRequest>) => this.decide(open, e.detail)}
      ></tt-approval-card>`;
  }
}

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
