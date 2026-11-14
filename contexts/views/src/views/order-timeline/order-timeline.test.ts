import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ErrorEnvelopeSchema, OrderSchema, REASON_TEXT } from "@app/contract";
import {
  formatDeliveryDate,
  formatMoney,
  formatOrderNumber,
  formatQuantity,
  formatTimestamp,
  ORDER_ACTORS,
  ORDER_OUTCOMES,
  ORDER_STATUS_LABELS,
} from "@app/ui/format";
import type { TemplateResult } from "lit";
import { CARD } from "../approval-card/card-strings.ts";
import { clickHandler, markup } from "../approval-card/template-walk.ts";
import { money, orderName } from "../approval-card/parts.ts";
import { setLang } from "../../shared/locale.ts";
import {
  COLLAPSED,
  renderOrderTimeline,
  type TimelineActions,
  type TimelineUi,
} from "./order-timeline.ts";
import { TIMELINE } from "./strings.ts";

/** Everything open: More details, every log entry and the note. */
const OPEN: TimelineUi = { details: true, entry: "all", note: true };

const fixtures = resolve(import.meta.dir, "../../../fixtures/order-timeline");
const fixture = (name: string) => Bun.file(resolve(fixtures, `${name}.json`)).json();

// Extract nested Lit template text without requiring a DOM in Bun.
const text = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (
    typeof value === "object" &&
    "strings" in value &&
    "values" in value &&
    Array.isArray(value.strings) &&
    value.strings.every((part: unknown): part is string => typeof part === "string") &&
    Array.isArray(value.values)
  ) {
    const values: unknown[] = value.values;
    return value.strings
      .map(
        (part, index) =>
          `${part.replace(/<[^>]*>/g, " ")} ${part.endsWith("title=") ? "" : text(values[index])}`,
      )
      .join(" ");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};
const visible = (result: TemplateResult) =>
  text(result)
    .replace(/[\t\r\n ]+/g, " ")
    .trim();

test("timeline fixtures satisfy the contract and describe their named state", async () => {
  for (const [name, status] of [
    ["done", "pending_approval"],
    ["placed", "placed"],
    ["pending", "pending_approval"],
    ["declined", "declined"],
    ["rejected", "rejected"],
    ["requoted", "pending_approval"],
  ] as const) {
    const order = OrderSchema.parse(await fixture(name));
    expect(order.status).toBe(status);
  }
  expect(ErrorEnvelopeSchema.parse(await fixture("error")).error.message).toContain("wholesaler");
});

test("audit events expose shared actors, UTC time and readable reason", async () => {
  const order = OrderSchema.parse(await fixture("rejected"));
  const output = visible(renderOrderTimeline(order, OPEN));
  expect(output).toContain(formatOrderNumber(order.orderId));
  expect(output).toContain(ORDER_ACTORS.agent);
  expect(output).toContain(ORDER_ACTORS.server);
  expect(output).toContain(REASON_TEXT.CREDIT_LIMIT);
  expect(output).not.toContain("CREDIT_LIMIT");
  const rejected = order.audit.find((event) => event.event === "rejected");
  if (!rejected) throw new Error("Rejected fixture must include a rejection event");
  expect(output).toContain(formatTimestamp(rejected.at));
  expect(output).toContain("UTC");
  for (const event of order.audit) {
    if (event.rule) expect(output).not.toContain(event.rule);
  }
});

test("audit event shows a reason only once when its detail repeats it", async () => {
  const order = OrderSchema.parse(await fixture("pending"));
  const event = order.audit.find((entry) => entry.reason === "NEW_PRODUCT");
  if (!event) throw new Error("Pending fixture must include a new product audit event");
  const reason = "The product has not been ordered before.";
  const withDetail = OrderSchema.parse({
    ...order,
    audit: [{ ...event, detail: reason }],
  });
  const output = visible(renderOrderTimeline(withDetail, OPEN));
  expect(output.split(reason).length - 1).toBe(1);
});

test("audit event shows distinct reason and detail once each", async () => {
  const order = OrderSchema.parse(await fixture("pending"));
  const event = order.audit.find((entry) => entry.reason === "NEW_PRODUCT");
  if (!event) throw new Error("Pending fixture must include a new product audit event");
  const reason = "The product has not been ordered before.";
  const detail = "Review this product with the customer.";
  const withDetail = OrderSchema.parse({
    ...order,
    audit: [{ ...event, detail }],
  });
  const output = visible(renderOrderTimeline(withDetail, OPEN));
  expect(output.split(reason).length - 1).toBe(1);
  expect(output.split(detail).length - 1).toBe(1);
});
test("declined decisions show the chosen next step and note", async () => {
  const order = OrderSchema.parse(await fixture("declined"));
  const stop = visible(renderOrderTimeline(order));
  expect(stop).toContain(ORDER_OUTCOMES.stop);
  expect(stop).toContain("Please stop this order.");
  expect(stop).toContain(ORDER_ACTORS.approver);

  const alternatives = OrderSchema.parse({
    ...order,
    decision: { ...order.decision, next: "alternatives", note: "Try another option instead." },
  });
  const other = visible(renderOrderTimeline(alternatives));
  expect(other).toContain(ORDER_OUTCOMES.alternatives);
  expect(other).toContain("Try another option instead.");
});

test("each requote shows previous and current gross prices with currency", async () => {
  const order = OrderSchema.parse(await fixture("requoted"));
  const output = visible(renderOrderTimeline(order));
  for (const quote of order.requotes) {
    expect(output).toContain(
      formatMoney(quote.previous.unitPrice.net, quote.previous.unitPrice.currency, "net"),
    );
    expect(output).toContain(
      formatMoney(quote.current.unitPrice.net, quote.current.unitPrice.currency, "net"),
    );
    expect(output).toContain(
      formatMoney(quote.previous.total.gross, quote.previous.unitPrice.currency, "gross"),
    );
    expect(output).toContain(
      formatMoney(quote.current.total.gross, quote.current.unitPrice.currency, "gross"),
    );
    expect(output).toContain(formatTimestamp(quote.at));
    expect(output).not.toContain(quote.current.productId);
  }
  expect(output).toContain(REASON_TEXT.PRICE_CHANGED);
  expect(output).not.toContain("PRICE_CHANGED");
});

test("summary uses shared order labels, totals and line formatting", async () => {
  for (const name of ["pending", "placed", "requoted"]) {
    const order = OrderSchema.parse(await fixture(name));
    const output = visible(renderOrderTimeline(order));
    expect(output).toContain(formatMoney(order.total.gross, "EUR", "gross"));
    for (const { claims } of order.lines) {
      expect(output).toContain(claims.product.name);
      expect(output).toContain(formatQuantity(claims.quantity));
      expect(output).toContain(formatDeliveryDate(claims.deliveryDate));
      expect(output).not.toContain(claims.productId);
    }
    if (order.status === "placed") expect(output).toContain(ORDER_OUTCOMES.placed);
  }
});

test("unknown quantity units stay in support metadata", async () => {
  const order = OrderSchema.parse(await fixture("pending"));
  const line = order.lines[0];
  if (!line) throw new Error("Pending fixture must include an order line");
  const quantity = { ...line.claims.quantity, unit: "UNKNOWN_UNIT_CODE" };
  const updated = { ...order, lines: [{ ...line, claims: { ...line.claims, quantity } }] };
  const output = visible(renderOrderTimeline(updated));
  expect(output).toContain(formatQuantity(quantity));
  expect(output).not.toContain(quantity.unit);
});

test("empty orders still show the gross EUR total", async () => {
  const order = OrderSchema.parse(await fixture("pending"));
  const output = visible(renderOrderTimeline({ ...order, lines: [] }));
  expect(output).toContain(formatMoney(order.total.gross, "EUR", "gross"));
});

test("the order log shows the audit integrity per log and per entry (#74)", async () => {
  const intact = visible(renderOrderTimeline(OrderSchema.parse(await fixture("log-intact"))));
  expect(intact).toContain("Log intact. All 2 entries are signed and in order.");
  const unverified = visible(
    renderOrderTimeline(OrderSchema.parse(await fixture("log-unverified"))),
  );
  expect(unverified).toContain("Can’t check the log right now.");
  const broken = visible(renderOrderTimeline(OrderSchema.parse(await fixture("log-broken"))));
  expect(broken).toContain("1 entry was changed after it was written. Don’t rely on this log.");
  expect(broken).toContain("This entry doesn’t match its signature.");
  const plain = visible(renderOrderTimeline(OrderSchema.parse(await fixture("placed"))));
  expect(plain).not.toContain("Log intact");
  expect(plain).not.toContain("doesn’t match its signature");
});

test("the timeline opens with the approval card's order header in every state", async () => {
  const states = [
    ["pending", CARD.en.approvalRequired],
    ["placed", CARD.en.approved],
    ["declined", ORDER_STATUS_LABELS.declined],
    ["rejected", ORDER_STATUS_LABELS.rejected],
  ] as const;
  for (const [name, label] of states) {
    const order = OrderSchema.parse(await fixture(name));
    const output = visible(renderOrderTimeline(order));
    const header = output.slice(0, output.indexOf(" Products ") + 12);
    expect(header).toContain(label);
    expect(header).toContain(orderName(order));
    expect(header).toContain(`${money(order.total.net)} excl. VAT`);
    expect(header).toContain(`Order no. ${formatOrderNumber(order.orderId)}`);
    expect(header).toContain(`Products ${order.lines.length}`);
  }
  const placed = OrderSchema.parse(await fixture("placed"));
  const waiting = visible(renderOrderTimeline({ ...placed, status: "awaiting_payment" }));
  expect(waiting).toContain(CARD.en.approvedWaiting);
});

/** Actions that record what was clicked, so a test can press a button without a DOM. */
/** A template's markup on one line, whitespace collapsed. */
const flat = (value: unknown) => markup(value).replace(/\s+/g, " ");

const recorder = () => {
  const calls: string[] = [];
  const act: TimelineActions = {
    toggleDetails: () => calls.push("details"),
    toggleEntry: (index) => calls.push(`entry ${index}`),
    toggleNote: () => calls.push("note"),
  };
  return { calls, act };
};

test("the order log sits in the card's More details footer, closed by default", async () => {
  const order = OrderSchema.parse(await fixture("declined"));
  const { calls, act } = recorder();
  const closed = renderOrderTimeline(order, COLLAPSED, act);
  const shut = flat(closed);
  expect(shut).toContain('aria-expanded=false aria-controls="details-body"');
  expect(shut).toContain('class="details-body "');
  expect(shut).toContain(`<span class="more">${CARD.en.moreDetails}</span`);
  expect(shut).toContain(`<span class="hint">${CARD.en.offerAndSignature}</span>`);
  expect(shut).not.toContain('class="offer-details"');
  clickHandler(closed, 'aria-controls="details-body"')?.();
  expect(calls).toEqual(["details"]);

  const open = flat(renderOrderTimeline(order, { ...COLLAPSED, details: true }));
  expect(open).toContain('aria-expanded=true aria-controls="details-body"');
  expect(open).toContain('class="details-body open"');
  expect(open).toContain(CARD.en.fewerDetails);
  expect(open).not.toContain(CARD.en.offerAndSignature);
  expect(open).toContain(
    `${TIMELINE.en.orderLog} <span class="count body-small secondary">3 entries`,
  );
});

test("each log entry opens on its own", async () => {
  const order = OrderSchema.parse(await fixture("declined"));
  const { calls, act } = recorder();
  const second = renderOrderTimeline(order, { ...COLLAPSED, details: true, entry: 1 }, act);
  const shown = flat(second);
  expect(shown).toContain("aria-expanded=true aria-controls=entry-1");
  expect(shown).toContain("aria-expanded=false aria-controls=entry-0");
  expect(shown).toContain("aria-expanded=false aria-controls=entry-2");
  expect(shown).toContain('class="offer-details" id=entry-1');
  expect(shown).toContain('<span class="offer-price">11.12 UTC</span>');
  expect(shown).not.toContain("id=entry-0");
  expect(shown).not.toContain("id=entry-2");
  clickHandler(second, "aria-controls=entry-2")?.();
  expect(calls).toEqual(["entry 2"]);
});

test("entry titles are bold and take the colour of their outcome", async () => {
  const declined = flat(renderOrderTimeline(OrderSchema.parse(await fixture("declined")), OPEN));
  expect(declined).toContain('class="strong event-title neutral">Order requested<');
  expect(declined).toContain('class="strong event-title danger">Declined<');
  expect(declined).toContain('class="offer-status danger"');
  const placed = flat(renderOrderTimeline(OrderSchema.parse(await fixture("placed")), OPEN));
  expect(placed).toContain('class="strong event-title auto">Order placed<');
  const rejected = flat(renderOrderTimeline(OrderSchema.parse(await fixture("rejected")), OPEN));
  expect(rejected).toContain('class="strong event-title danger">Order rejected<');
});

test("the footer and the log are in Finnish when the view is", async () => {
  const order = OrderSchema.parse(await fixture("declined"));
  setLang("fi");
  try {
    const closed = visible(renderOrderTimeline(order));
    expect(closed).toContain(CARD.fi.moreDetails);
    expect(closed).toContain(CARD.fi.offerAndSignature);
    expect(closed).toContain(`${TIMELINE.fi.orderLog} ${TIMELINE.fi.entries(3)}`);
    const open = visible(renderOrderTimeline(order, OPEN));
    expect(open).toContain(CARD.fi.fewerDetails);
    expect(open).toContain(TIMELINE.fi.events.declined);
    expect(open).toContain(TIMELINE.fi.facts.note);
    expect(flat(renderOrderTimeline(order))).toContain(
      '<span class="offer-price">11.12 UTC</span>',
    );
  } finally {
    setLang("en");
  }
});

test("a long decline note is clamped behind Show more", async () => {
  const declined = OrderSchema.parse(await fixture("declined"));
  const note = "The supplier changed the delivery day twice this week. ".repeat(4).trim();
  const order = OrderSchema.parse({ ...declined, decision: { ...declined.decision, note } });
  const { calls, act } = recorder();
  const clamped = renderOrderTimeline(order, COLLAPSED, act);
  const shut = flat(clamped);
  expect(shut).toContain('class="note clamped"');
  expect(shut).toContain('aria-expanded=false aria-controls="decision-note"');
  expect(visible(clamped)).toContain(TIMELINE.en.showMore);
  clickHandler(clamped, 'aria-controls="decision-note"')?.();
  expect(calls).toEqual(["note"]);

  const full = renderOrderTimeline(order, { ...COLLAPSED, note: true });
  expect(flat(full)).toContain('class="note "');
  expect(visible(full)).toContain(TIMELINE.en.showLess);
  expect(flat(renderOrderTimeline(declined))).not.toContain("note-toggle");
});
