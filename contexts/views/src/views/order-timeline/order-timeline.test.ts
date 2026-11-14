import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ErrorEnvelopeSchema, OrderSchema, REASON_TEXT } from "@app/contract";
import type { TemplateResult } from "lit";
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
      .map((part, index) => `${part.replace(/<[^>]*>/g, " ")} ${text(values[index])}`)
      .join(" ");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};
const visible = (result: TemplateResult) => text(result).replace(/\s+/g, " ").trim();

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

test("audit events expose actor, local time and readable reason", async () => {
  const order = OrderSchema.parse(await fixture("rejected"));
  const output = visible(renderOrderTimeline(order));
  expect(output).toContain(order.orderId);
  expect(output.toLowerCase()).toContain("agent");
  expect(output.toLowerCase()).toContain("server");
  expect(output).toContain(REASON_TEXT.CREDIT_LIMIT);
  expect(output).not.toContain("CREDIT_LIMIT");
  const rejected = order.audit.find((event) => event.event === "rejected");
  if (!rejected) throw new Error("Rejected fixture must include a rejection event");
  const localTime = new Date(rejected.at).toLocaleString();
  expect(output).toContain(localTime);
});
test("declined decisions show the chosen next step and note", async () => {
  const order = OrderSchema.parse(await fixture("declined"));
  const stop = visible(renderOrderTimeline(order));
  expect(stop.toLowerCase()).toContain("stop");
  expect(stop).toContain("Please stop this order.");
  expect(stop.toLowerCase()).toContain("approver");

  const alternatives = OrderSchema.parse({
    ...order,
    decision: { ...order.decision, next: "alternatives", note: "Try another option instead." },
  });
  const other = visible(renderOrderTimeline(alternatives));
  expect(other.toLowerCase()).toContain("alternative");
  expect(other).toContain("Try another option instead.");
});

test("each requote shows previous and current gross prices with currency", async () => {
  const order = OrderSchema.parse(await fixture("requoted"));
  const output = visible(renderOrderTimeline(order));
  expect(output).toMatch(/65[.,]66/);
  expect(output).toMatch(/68[.,]40/);
  expect(output).toMatch(/70[.,]68/);
  expect(output.match(/68[.,]40/g)?.length).toBe(2);
  expect(output).toMatch(/14[.,]40.*15[.,]00.*15[.,]00.*15[.,]50/);
  expect(output).toMatch(/EUR|€/);
  expect(output).toContain(REASON_TEXT.PRICE_CHANGED);
  expect(output).not.toContain("PRICE_CHANGED");
});
