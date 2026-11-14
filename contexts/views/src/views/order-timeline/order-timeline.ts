import type { Order } from "@app/contract";
import {
  formatDeliveryDate,
  formatMoney,
  formatQuantity,
  formatTimestamp,
  ORDER_WORDING,
} from "@app/ui/format";
import { css, html, nothing, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import agent16 from "../../shared/icons/agent-16.svg?raw";
import { lang, pick } from "../../shared/locale.ts";
import { base } from "../../shared/styles.ts";
import { statusDisc, type Tone, trustStyles } from "../../shared/trust.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { CARD } from "../approval-card/card-strings.ts";
import {
  cardStyles,
  detailsFooter,
  disclosureRow,
  disclosureStyles,
  offerSeal,
  orderHeader,
  orderStateLabel,
  type RowTone,
  rows,
  thumb,
} from "../approval-card/parts.ts";

import { TIMELINE } from "./strings.ts";

/** The audit integrity strip (#74): the server's signature check of the whole log. */
function integrityStrip(order: Order) {
  const integrity = order.auditIntegrity;
  if (integrity === undefined) return nothing;
  const text = pick(TIMELINE);
  const changed = order.audit.filter((e) => e.integrityOk === false).length;
  const [tone, message]: [Tone, string] =
    integrity === "intact"
      ? ["success", text.logIntact(order.audit.length)]
      : integrity === "unverified"
        ? ["warning", text.logUnverified]
        : ["danger", text.logBroken(changed)];
  return html`<p class="strip ${tone} strong" role="status" aria-live="polite">
    ${statusDisc(tone, true)}<span>${message}</span>
  </p>`;
}

type AuditEvent = Order["audit"][number];

/** How each log entry reads: went through (check), needs a look (warning) or a plain step. */
const EVENT_TONE = {
  order_requested: "neutral",
  order_refused: "danger",
  offer_verified: "auto",
  check_passed: "auto",
  check_failed: "attention",
  sent_to_approval: "neutral",
  approved: "auto",
  declined: "danger",
  requoted: "neutral",
  edited: "neutral",
  payment_authorized: "auto",
  payment_failed: "danger",
  placed: "auto",
  rejected: "danger",
} satisfies Record<AuditEvent["event"], RowTone>;

/** A note longer than this is clamped to two lines behind "Show more". */
const LONG_NOTE = 140;

/** Which parts of the timeline are open: More details, one log entry (or all) and the note. */
export type TimelineUi = { details: boolean; entry: number | "all" | null; note: boolean };
export const COLLAPSED: TimelineUi = { details: false, entry: null, note: false };
export type TimelineActions = {
  toggleDetails: () => void;
  toggleEntry: (index: number) => void;
  toggleNote: () => void;
};
const NO_ACTIONS: TimelineActions = {
  toggleDetails: () => undefined,
  toggleEntry: () => undefined,
  toggleNote: () => undefined,
};

/** One log entry as the card's opening row: icon and event, time and chevron; open, the facts. */
function logEntry(event: AuditEvent, index: number, ui: TimelineUi, act: TimelineActions) {
  const text = pick(TIMELINE);
  const words = pick(ORDER_WORDING);
  const l = lang();
  const title = text.events[event.event];
  const time = formatTimestamp(event.at, l);
  const actor = words.actors[event.actor];
  const reason = event.reason ? text.reason[event.reason] : undefined;
  const detail =
    event.detail && (!event.reason || event.detail !== text.reason[event.reason])
      ? event.detail
      : undefined;
  const facts: [string, unknown][] = [
    [text.facts.time, html`<time datetime=${event.at}>${time}</time>`],
    [text.facts.by, actor],
  ];
  if (detail !== undefined)
    facts.push([event.event === "declined" ? text.facts.note : text.facts.detail, detail]);
  if (event.rule)
    facts.push([text.facts.rule, html`<span title=${event.rule}>${text.supportRule}</span>`]);
  const open = ui.entry === "all" || ui.entry === index;
  const tone = EVENT_TONE[event.event];
  return html`<li class=${event.integrityOk === false ? "broken" : ""}>
    ${disclosureRow({
      panel: `entry-${index}`,
      open,
      toggle: () => act.toggleEntry(index),
      label: text.entryLabel(title, time, actor),
      tone,
      lead: html`${
          event.actor === "agent"
            ? html`<span class="agent" aria-hidden="true">${unsafeSVG(agent16)}</span>`
            : nothing
        }<span class="strong event-title ${tone}">${title}</span>`,
      value: /\d{1,2}[.:]\d{2} UTC$/.exec(time)?.[0] ?? time,
      sentence: reason,
      facts,
    })}
    ${
      event.integrityOk === false
        ? html`<p class="strong tampered body-small">${text.entryChanged}</p>`
        : nothing
    }
  </li>`;
}

/** The order log inside More details: its integrity strip and one opening row per entry. */
function orderLog(order: Order, ui: TimelineUi, act: TimelineActions) {
  const text = pick(TIMELINE);
  return html`<section class="group log" aria-label=${text.orderLog}>
    <h3 class="section-title">
      ${text.orderLog}
      <span class="count body-small secondary">${text.entries(order.audit.length)}</span>
    </h3>
    ${integrityStrip(order)}
    ${
      order.audit.length === 0
        ? html`<p class="secondary">${text.noActivity}</p>`
        : html`<ol class="events">
            ${order.audit.map((event, index) => logEntry(event, index, ui, act))}
          </ol>`
    }
  </section>`;
}

/** The decision note, clamped to two lines behind "Show more" when it is long. */
function decisionNote(note: string, ui: TimelineUi, act: TimelineActions) {
  const text = pick(TIMELINE);
  if (note.length <= LONG_NOTE) return html`<p>${text.note(note)}</p>`;
  return html`<p id="decision-note" class="note ${ui.note ? "" : "clamped"}">${text.note(note)}</p>
    <button
      type="button"
      class="note-toggle body-small"
      aria-expanded=${ui.note ? "true" : "false"}
      aria-controls="decision-note"
      @click=${act.toggleNote}
    >
      ${ui.note ? text.showLess : text.showMore}
    </button>`;
}

/** Render the order record without adding actions to the audit view. */
export function renderOrderTimeline(
  order: Order,
  ui: TimelineUi = COLLAPSED,
  act: TimelineActions = NO_ACTIONS,
): TemplateResult {
  const decision = order.decision;
  const text = pick(TIMELINE);
  const words = pick(ORDER_WORDING);
  const l = lang();
  return html`<article class="card timeline" part="done" aria-label=${text.eyebrow}>
    ${orderHeader(order, orderStateLabel(order), order.total.net, order.status === "pending_approval")}
    <div class="body">
      <section aria-label=${text.summaryLabel}>
        <h3 class="section-title">${text.summaryLabel}</h3>
        <p class="total">${text.total(formatMoney(order.total.gross, "EUR", "gross", l))}</p>
        <ul class="lines">
          ${order.lines.map(
            ({ claims }) =>
              html`<li>
                ${thumb(claims.product.name)}
                <div>
                  <p class="strong" title=${claims.productId}>${claims.product.name}</p>
                  <p class="body-small secondary">
                    <span title=${claims.quantity.unit}>${formatQuantity(claims.quantity, l)}</span>
                    · ${formatDeliveryDate(claims.deliveryDate, l)}
                  </p>
                </div>
              </li>`,
          )}
        </ul>
      </section>
      ${order.status === "placed" ? html`<p class="decision">${words.outcomes.placed}</p>` : nothing}
      ${
        decision?.action === "reject"
          ? html`<div class="decision">
              <p class="strong">${text.approvalDeclined}</p>
              <p>
                ${
                  decision.next === "stop"
                    ? words.outcomes.stop
                    : decision.next === "alternatives"
                      ? words.outcomes.alternatives
                      : text.nextNotRecorded
                }
              </p>
              ${decision.note ? decisionNote(decision.note, ui, act) : nothing}
            </div>`
          : nothing
      }
      ${
        order.requotes.length === 0
          ? nothing
          : html`<section class="requotes" aria-label=${text.requotedOffers}>
              <h3 class="section-title">${text.requotedOffers}</h3>
              <ul>
                ${order.requotes.map(
                  (quote) =>
                    html`<li>
                      <p class="strong" title=${quote.current.productId}>
                        ${quote.current.product.name}
                      </p>
                      ${
                        quote.previous.productId !== quote.current.productId
                          ? html`<p class="body-small" title=${quote.previous.productId}>
                              ${text.previousProduct(quote.previous.product.name)}
                            </p>`
                          : nothing
                      }
                      <p>
                        ${text.unitPrice}
                        ${formatMoney(quote.previous.unitPrice.net, quote.previous.unitPrice.currency, "net", l)}
                        →
                        ${formatMoney(quote.current.unitPrice.net, quote.current.unitPrice.currency, "net", l)}
                      </p>
                      <p>
                        ${text.totalLabel}
                        ${formatMoney(quote.previous.total.gross, quote.previous.unitPrice.currency, "gross", l)}
                        →
                        ${formatMoney(quote.current.total.gross, quote.current.unitPrice.currency, "gross", l)}
                      </p>
                      <p class="secondary body-small">
                        <time datetime=${quote.at}>${formatTimestamp(quote.at, l)}</time>
                      </p>
                      ${quote.reasons.map((reason) => html`<p>${text.reason[reason]}</p>`)}
                    </li>`,
                )}
              </ul>
            </section>`
      }
    </div>
    ${detailsFooter({
      open: ui.details,
      toggle: act.toggleDetails,
      hint: pick(CARD).offerAndSignature,
      body: html`${orderLog(order, ui, act)}
        <section class="group">
          <h3 class="section-title">${pick(CARD).offer}</h3>
          ${rows([[pick(CARD).offerNo, order.offerIds.join(", ")]])} ${offerSeal(order)}
        </section>`,
    })}
  </article>`;
}

class OrderTimeline extends ViewElement<ViewEntryOf<"order-timeline">> {
  static override properties = { ...ViewElement.properties, ui: { state: true } };
  static override styles = [
    base,
    cardStyles,
    disclosureStyles,
    trustStyles,
    css`
      .timeline {
        overflow-wrap: anywhere;
      }
      .body section {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }
      h4 {
        font-weight: 700;
      }
      .lines,
      .events,
      .requotes ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      /* Product rows as on the card: image, name, then amount and delivery. */
      .lines li {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding-block: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
      }
      .lines li > div {
        min-width: 0;
      }
      .decision {
        padding: var(--spacing-md);
        background: var(--color-bg-subtle);
      }
      .decision p + p,
      .requotes li p + p {
        margin-top: var(--spacing-xs);
      }
      /* A long note: two lines until "Show more". */
      .note.clamped {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
      .note-toggle {
        margin-top: var(--spacing-xs);
        padding: 0;
        border: 0;
        background: none;
        color: var(--color-link);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .log .count {
        font-family: var(--font-family-sans);
        font-weight: 400;
      }
      /* Log entries are the card's opening rows, one per entry, with a divider under each. */
      .events li {
        border-bottom: 1px solid var(--color-border);
      }
      .events .offer-reason {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-2xs);
        color: var(--color-text);
        font-size: var(--font-size-sm);
      }
      /* The title takes its row's outcome colour: green done, amber flagged, red refused. */
      .events .event-title.auto {
        color: var(--color-text-success);
      }
      .events .event-title.attention {
        color: var(--color-text-warning);
      }
      .events .event-title.danger {
        color: var(--color-text-danger);
      }
      .events .agent {
        display: inline-flex;
        color: var(--color-text-brand);
      }
      .events .agent svg {
        width: 12px;
        height: 12px;
      }
      .events li.broken {
        background: var(--color-bg-danger);
      }
      .tampered {
        margin: 0 0 var(--spacing-xs);
        color: var(--color-text-danger);
      }
      .requotes li {
        padding: var(--spacing-md);
        border: 1px solid var(--color-border);
      }
      .requotes li + li {
        margin-top: var(--spacing-sm);
      }
    `,
  ];
  readonly entry = viewEntry("order-timeline");
  declare private ui: TimelineUi;

  constructor() {
    super();
    this.ui = COLLAPSED;
  }

  private readonly act: TimelineActions = {
    toggleDetails: () => (this.ui = { ...this.ui, details: !this.ui.details }),
    toggleEntry: (index) =>
      (this.ui = { ...this.ui, entry: this.ui.entry === index ? null : index }),
    toggleNote: () => (this.ui = { ...this.ui, note: !this.ui.note }),
  };

  protected override renderDone(order: ViewData<"order-timeline">) {
    return renderOrderTimeline(order, this.ui, this.act);
  }
}

export const defineOrderTimeline = () => defineView("tt-order-timeline", OrderTimeline);

declare global {
  interface HTMLElementTagNameMap {
    "tt-order-timeline": OrderTimeline;
  }
}
