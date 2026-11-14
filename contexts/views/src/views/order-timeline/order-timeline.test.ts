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
import { money, orderName } from "../approval-card/parts.ts";
import { renderOrderTimeline } from "./order-timeline.ts";

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
  const output = visible(renderOrderTimeline(order));
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
  const output = visible(renderOrderTimeline(withDetail));
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
  const output = visible(renderOrderTimeline(withDetail));
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
