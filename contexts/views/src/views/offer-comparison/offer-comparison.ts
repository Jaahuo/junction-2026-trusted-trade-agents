import { type OffersResult, OffersResultSchema, type StoredMandate } from "@app/contract";
import { brand } from "@app/ui/brand";
import { css, html, nothing, type TemplateResult } from "lit";
import { callAction, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import checkCircle from "../../shared/icons/check-circle.svg?raw";
import chevronDown from "../../shared/icons/chevron-down.svg?raw";
import minus16 from "../../shared/icons/minus-16.svg?raw";
import warning16 from "../../shared/icons/warning-16.svg?raw";
import { pick } from "../../shared/locale.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { cardStyles, icon } from "../approval-card/parts.ts";
import {
  accessibleName,
  askElseText,
  closed,
  details,
  explain,
  failed,
  heading,
  limitFor,
  linkState,
  type OfferedRow,
  type Option,
  orderNote,
  type Panel,
  type Price,
  retryText,
  type Row,
  rowsOf,
  sending,
  sent,
  show,
  type Status,
  steerStatus,
  toggle,
  type Ui,
  useText,
} from "./model.ts";
import { OFFERS } from "./strings.ts";

// Read-only: the view never orders or approves. "Use", "Ask for something else" and
// "Try again" hand a message to the chat through the host; approval happens later, on the
// approval card.

export type Handlers = {
  toggle: (key: string) => void;
  show: (panel: Panel, offerId?: string | null) => void;
  steer: (id: string, key: string, text: string) => void;
};

const idle: Handlers = { toggle: () => {}, show: () => {}, steer: () => {} };

const ICONS: Record<Status, string> = { auto: checkCircle, attention: warning16, none: minus16 };

/** A price per litre or kilogram, or a dash that a screen reader reads as "price unknown". */
const priceCell = (price: Price | null) =>
  price === null
    ? html`<span class="price"
        ><span aria-hidden="true">—</span
        ><span class="visually-hidden">${pick(OFFERS).priceUnknown}</span></span
      >`
    : html`<span class="price">${price.shown}</span>`;

const linkButton = (label: string, onClick: () => void, expanded?: boolean) =>
  html`<button
    type="button"
    class="link"
    aria-expanded=${expanded === undefined ? nothing : expanded ? "true" : "false"}
    @click=${onClick}
  >
    ${label}
  </button>`;

/**
 * A steering link stays the same button through its states, so keyboard focus stays on it:
 * "Asked ✓" and the waiting states are aria-disabled, not removed.
 */
function steerButton(label: string, id: string, ui: Ui, send: () => void) {
  const state = linkState(id, ui);
  const text = pick(OFFERS);
  return html`<button
    type="button"
    class="link ${state}"
    aria-disabled=${state === "enabled" ? "false" : "true"}
    @click=${() => (state === "enabled" ? send() : undefined)}
  >
    ${state === "asked" ? text.asked : state === "sending" ? text.sending : label}
  </button>`;
}

function action(row: OfferedRow, option: Option, ui: Ui, on: Handlers) {
  if (option.action === "pick") return html`<span class="tag">${pick(OFFERS).pick}</span>`;
  if (option.action === null || !ui.canSteer) return nothing;
  return steerButton(pick(OFFERS).use, option.line.offerId, ui, () =>
    on.steer(option.line.offerId, row.key, useText(row, option)),
  );
}

function options(row: OfferedRow, ui: Ui, on: Handlers) {
  const elseId = `else:${row.key}`;
  const detailsOf = ui.open?.panel === "details" ? ui.open.offerId : null;
  return html`<ul class="options" part="options">
      ${row.options.map(
        (option) =>
          html`<li class="option">
            ${icon(ICONS[option.status])}
            <span class="name">
              <button
                type="button"
                class="link plain"
                aria-expanded=${detailsOf === option.line.offerId ? "true" : "false"}
                @click=${() => on.show("details", option.line.offerId)}
              >
                ${option.line.claims.product.name}
              </button>
              ${option.differs === null ? nothing : html`<span class="differs secondary">${option.differs}</span>`}
            </span>
            <span class="reason">${option.reason ?? nothing}</span>
            ${priceCell(option.price)} ${action(row, option, ui, on)}
          </li>`,
      )}
    </ul>
    ${
      ui.canSteer
        ? steerButton(pick(OFFERS).askElse, elseId, ui, () =>
            on.steer(elseId, row.key, askElseText(row)),
          )
        : nothing
    }`;
}

function detailList(row: OfferedRow, offerId: string | null) {
  const line = row.options.find((o) => o.line.offerId === offerId)?.line ?? row.pick;
  return html`<dl class="details" part="details">
    ${line === row.pick ? nothing : html`<p class="strong">${line.claims.product.name}</p>`}
    ${details(line).map(
      ([label, value]) =>
        html`<div class="detail">
          <dt>${label}</dt>
          <dd>${value}</dd>
        </div>`,
    )}
  </dl>`;
}

function opened(row: Row, ui: Ui, on: Handlers, limit: number | null): TemplateResult {
  if (row.kind === "omitted")
    return html`<div class="panel" id=${`panel-${row.key}`}>
      <p class="body-small">${row.detail}</p>
    </div>`;
  const panel = ui.open?.panel ?? "summary";
  const others = row.options.length - 1;
  const catalogue = row.pick.claims.product.name;
  const retryId = `retry:${row.key}`;
  const text = pick(OFFERS);
  const status = steerStatus(row, ui);
  return html`<div class="panel" id=${`panel-${row.key}`}>
    ${catalogue === row.name ? nothing : html`<p class="catalogue">${catalogue}</p>`}
    <p class="sentence ${row.status}">${explain(row.pick, limit)}</p>
    ${
      row.pick.precheck === null && ui.canSteer
        ? steerButton(text.tryAgain, retryId, ui, () => on.steer(retryId, row.key, retryText(row)))
        : nothing
    }
    <div class="links">
      ${linkButton(
        text.details,
        () => on.show("details", null),
        panel === "details" && ui.open?.offerId === null,
      )}
      ${linkButton(text.otherOptions(others), () => on.show("options"), panel === "options")}
    </div>
    ${panel === "options" ? options(row, ui, on) : nothing}
    ${panel === "details" ? detailList(row, ui.open?.offerId ?? null) : nothing}
    <p class="visually-hidden" role="status">
      ${status === "sending" ? text.sendingStatus : status === "sent" ? text.sentStatus : ""}
    </p>
  </div>`;
}

function productRow(item: Row, ui: Ui, on: Handlers, limit: number | null) {
  const open = ui.open?.key === item.key;
  const error = ui.error?.key === item.key ? pick(OFFERS).sendFailed : null;
  return html`<li class="product ${item.status}">
    <button
      type="button"
      class="row"
      aria-expanded=${open ? "true" : "false"}
      aria-controls=${`panel-${item.key}`}
      aria-label=${accessibleName(item)}
      @click=${() => on.toggle(item.key)}
    >
      ${icon(ICONS[item.status])}
      <span class="name">${item.name}</span>
      <span class="reason">${item.reason ?? nothing}</span>
      ${item.kind === "offered" ? priceCell(item.price) : nothing}
      <span class="chevron">${icon(chevronDown)}</span>
    </button>
    ${open ? opened(item, ui, on, limit) : nothing}
    ${error === null ? nothing : html`<p class="error body-small" role="alert">${error}</p>`}
  </li>`;
}

const brandHead = (title: string, until: string | null) =>
  html`<header class="header" part="header">
    <div class="eyebrow-row spread">
      <span class="brand">
        <img src=${brand.logo} alt=${brand.name} />
        <span class="divider" aria-hidden="true"></span>
        <h2 class="title">${title}</h2>
      </span>
      ${until === null ? nothing : html`<p class="until">${until}</p>`}
    </div>
  </header>`;

/**
 * The glance: one row per requested line; the open product's levels follow its row. `limit`
 * is the gross order limit the pre-checks used (see limitFor), when known, for the amounts
 * over it.
 */
export function renderOfferComparison(
  data: OffersResult,
  ui: Ui = closed,
  on: Handlers = idle,
  limit: number | null = null,
): TemplateResult {
  const rows = rowsOf(data);
  const head = heading(data, rows);
  const note = orderNote(rows, limit);
  return html`<section class="card" part="done">
    ${brandHead(head.title, head.until)}
    ${
      data.offers.length === 0
        ? html`<p class="body-small nothing-offered" part="empty">${pick(OFFERS).noneOffered}</p>`
        : nothing
    }
    <ul class="products">
      ${rows.map((item) => productRow(item, ui, on, limit))}
    </ul>
    ${note === null ? nothing : html`<p class="note body-small secondary">${note}</p>`}
  </section>`;
}

/** Before the result arrives: the branded frame with three placeholder rows. */
export function renderLoading(): TemplateResult {
  return html`<section class="card" part="loading" aria-busy="true">
    ${brandHead(pick(OFFERS).gettingOffers, null)}
    <ul class="products">
      ${[0, 1, 2].map(
        () =>
          html`<li class="product">
            <span class="row skeleton-row"><span class="skeleton shimmer"></span></span>
          </li>`,
      )}
    </ul>
  </section>`;
}

const styles = css`
  .header {
    padding: var(--spacing-md) var(--spacing-lg);
  }
  .header .eyebrow-row {
    flex-wrap: wrap;
    row-gap: var(--spacing-2xs);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-md);
    min-width: 0;
  }
  .header .title {
    margin: 0;
    font-family: inherit;
    font-size: var(--font-size-sm);
    font-weight: 600;
    line-height: 1.25;
    white-space: nowrap;
  }
  .until {
    color: var(--color-text-on-brand-subtle);
    font-size: var(--font-size-xs);
    white-space: nowrap;
  }
  .nothing-offered,
  .note {
    padding: var(--spacing-md) var(--spacing-lg);
  }
  .note {
    border-top: 1px solid var(--color-border);
  }
  .products,
  .options {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .product + .product {
    border-top: 1px solid var(--color-border);
  }
  .row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: var(--spacing-sm);
    width: 100%;
    min-height: 44px;
    padding: var(--spacing-sm) var(--spacing-lg);
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:focus-visible,
  .link:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--color-border-brand) 45%, transparent);
    outline-offset: -3px;
  }
  .product > .row .icon svg {
    width: 16px;
    height: 16px;
  }
  .product.none > .row .icon {
    color: var(--color-text-secondary);
  }
  .row[aria-expanded="true"] .chevron .icon {
    transform: rotate(180deg);
  }
  .name {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .reason {
    color: var(--color-text-warning);
    font-size: var(--font-size-xs);
  }
  .product.none .reason {
    color: var(--color-text-secondary);
  }
  .price {
    font-size: var(--font-size-xs);
    white-space: nowrap;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
    padding: 0 var(--spacing-lg) var(--spacing-md) var(--spacing-2xl);
  }
  .sentence {
    font-size: var(--font-size-xs);
  }
  .sentence.attention {
    color: var(--color-text-warning);
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-lg);
  }
  .link {
    min-width: 24px;
    min-height: 24px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-link);
    font: inherit;
    font-size: var(--font-size-xs);
    cursor: pointer;
  }
  .link.plain {
    color: inherit;
    text-align: left;
  }
  .panel > .link {
    align-self: flex-start;
  }
  .link[aria-disabled="true"] {
    cursor: default;
  }
  .link.disabled,
  .link.sending {
    color: var(--color-border-strong);
  }
  .link.asked {
    color: var(--color-text-success);
    font-weight: 700;
  }
  .option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: var(--spacing-sm);
    min-height: 32px;
    font-size: var(--font-size-xs);
  }
  .option .name {
    display: flex;
    flex-direction: column;
  }
  .differs {
    font-size: var(--font-size-2xs);
  }
  .tag {
    padding: var(--spacing-2xs) var(--spacing-sm);
    border-radius: var(--radius-full);
    background: var(--color-bg-brand);
    color: var(--color-text-on-brand);
    font-size: var(--font-size-2xs);
    font-weight: 700;
  }
  .details {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
    margin: 0;
    font-size: var(--font-size-xs);
  }
  .detail {
    display: flex;
    gap: var(--spacing-md);
  }
  .detail dt {
    flex-shrink: 0;
    width: 104px;
    color: var(--color-text-secondary);
  }
  .detail dd {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .error {
    padding: 0 var(--spacing-lg) var(--spacing-md) var(--spacing-2xl);
    color: var(--color-text-danger);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .skeleton-row {
    cursor: default;
  }
  .skeleton {
    grid-column: 1 / -1;
    height: 12px;
    border-radius: var(--radius-full);
  }
`;

/** How long a steering message may wait for the host before its link is free again. */
const SEND_TIMEOUT_MS = 10_000;

class OfferComparison extends ViewElement<ViewEntryOf<"offer-comparison">> {
  static override properties = {
    ...ViewElement.properties,
    ui: { state: true },
    omitted: { state: true },
    mandate: { state: true },
  };
  static override styles = [base, cardStyles, styles];
  readonly entry = viewEntry("offer-comparison");
  declare private ui: Ui;
  /** The products left out, kept for a result with no offers (the shell shows it as empty). */
  declare private omitted: OffersResult["omitted"];
  /** The current mandate, for the order limit (see limitFor); null until read or when it
   * could not be read. */
  declare private mandate: StoredMandate | null;

  constructor() {
    super();
    this.ui = closed;
    this.omitted = [];
    this.mandate = null;
  }

  override connectedCallback() {
    super.connectedCallback();
    const source = this.source;
    if (source === null) return;
    this.ui = { ...this.ui, canSteer: source.message !== undefined };
    // The shell drops a result without offers as empty; keep why each product was left out.
    // A failed load is already the shell's error state, so only a parsed result is used.
    void source.load().then(
      (raw) => {
        const parsed = OffersResultSchema.safeParse(raw);
        if (parsed.success) this.omitted = parsed.data.omitted;
      },
      () => undefined,
    );
    // Without the mandate the sentences name no amount; the view still shows everything else.
    // A revoked mandate is kept, and limitFor gives no limit for it.
    void callAction(source, "get_mandate", {}, null).then((result) => {
      if (result.kind === "done") this.mandate = result.data;
      else
        console.error("The offer comparison could not read the mandate.", {
          tool: "get_mandate",
          message: result.kind === "error" ? result.message : result.kind,
        });
    });
  }

  private readonly on: Handlers = {
    toggle: (key) => (this.ui = toggle(this.ui, key)),
    show: (panel, offerId = null) => (this.ui = show(this.ui, panel, offerId)),
    steer: (id, key, text) => void this.steer(id, key, text),
  };

  private async steer(id: string, key: string, text: string) {
    const message = this.source?.message;
    const next = message === undefined ? null : sending(this.ui, id, key);
    if (message === undefined || next === null) return;
    this.ui = next;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`No answer from the chat in ${SEND_TIMEOUT_MS / 1000} s.`)),
        SEND_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([message(text), timeout]);
      this.ui = sent(this.ui);
    } catch (cause) {
      console.error("A steering message did not reach the chat.", {
        id,
        key,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      this.ui = failed(this.ui);
    } finally {
      clearTimeout(timer);
    }
  }

  override render() {
    if (this.state.kind === "loading") return renderLoading();
    if (this.state.kind === "empty" && this.omitted.length > 0)
      return renderOfferComparison({ offers: [], omitted: this.omitted }, this.ui, this.on, null);
    return super.render();
  }

  protected override renderDone(data: OffersResult) {
    return renderOfferComparison(data, this.ui, this.on, limitFor(data.offers, this.mandate));
  }
}

export const defineOfferComparison = () => defineView("tt-offer-comparison", OfferComparison);

declare global {
  interface HTMLElementTagNameMap {
    "tt-offer-comparison": OfferComparison;
  }
}
