import { describe, expect, test } from "bun:test";
import {
  ORDER_ACTIONS,
  ORDER_ACTORS,
  ORDER_OUTCOMES,
  ORDER_STATUS_LABELS,
  ORDER_TERMS,
  formatDeliveryDate,
  formatMoney,
  formatOrderNumber,
  formatQuantity,
  formatTimestamp,
} from "./format.ts";

test("order wording is consistent", () => {
  expect(ORDER_STATUS_LABELS).toEqual({
    pending_approval: "Needs your approval",
    awaiting_payment: "Awaiting payment",
    placed: "Placed",
    rejected: "Rejected",
    declined: "Declined",
  });
  expect(ORDER_ACTIONS).toEqual({
    approve: "Approve order",
    rejectStop: "Reject and stop",
    rejectAlternatives: "Reject, allow alternatives",
  });
  expect(ORDER_OUTCOMES).toEqual({
    placed: "The order is placed at the offered price and delivery date.",
    stop: "The agent stops and tells the approver.",
    alternatives: "The agent may look for alternatives.",
  });
  expect(ORDER_ACTORS).toEqual({ agent: "Agent", server: "Server", approver: "Approver" });
  expect(ORDER_TERMS).toEqual({ limit: "Order limit", paymentOnOrder: "Pay on order" });
});

describe("money", () => {
  for (const [value, currency, basis] of [
    [0, "EUR", "net"],
    [-12.345, "EUR", "gross"],
    [1.239, "USD", "net"],
    [1234.6, "JPY", "gross"],
  ] as const) {
    test(`${value} ${currency} ${basis}`, () => {
      expect(formatMoney(value, currency, basis)).toBe(
        `${new Intl.NumberFormat("en-FI", { style: "currency", currency }).format(value)} (${basis})`,
      );
    });
  }
  test("rejects invalid currency and nonfinite amounts", () => {
    expect(formatMoney(1, "not a currency", "net")).toBe("Amount unavailable (net)");
    for (const value of [NaN, Infinity, -Infinity])
      expect(formatMoney(value, "EUR", "gross")).toBe("Amount unavailable (gross)");
  });
});

describe("dates", () => {
  test("delivery date includes weekday and is timezone independent", () => {
    expect(formatDeliveryDate("2026-11-16")).toBe(
      new Intl.DateTimeFormat("en-FI", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date("2026-11-16T00:00:00Z")),
    );
    expect(formatDeliveryDate("2024-02-29")).not.toBe("Delivery date unavailable");
    for (const value of ["", "2026-02-29", "2026-11-31", "2026-13-01", "2026-11-16T00:00:00Z"])
      expect(formatDeliveryDate(value)).toBe("Delivery date unavailable");
  });
  test("timestamps use UTC across date boundaries", () => {
    expect(formatTimestamp("2026-11-16T00:30:00+02:00")).toBe(
      formatTimestamp("2026-11-15T22:30:00Z"),
    );
    expect(formatTimestamp("2026-11-15T23:30:00-02:00")).toBe(
      formatTimestamp("2026-11-16T01:30:00Z"),
    );
    expect(formatTimestamp("2026-11-16T00:30:00Z")).toContain("UTC");
    for (const fraction of ["1", "123", "123456", "123456789"])
      expect(formatTimestamp(`2026-11-16T00:30:00.${fraction}Z`)).toBe(
        formatTimestamp("2026-11-16T00:30:00Z"),
      );
    for (const value of [
      "",
      "2026-02-30T12:00:00Z",
      "2026-11-16T24:00:00Z",
      "2026-11-16T12:00:00",
      "invalid",
    ])
      expect(formatTimestamp(value)).toBe("Time unavailable");
  });
});

describe("quantities", () => {
  for (const [unit, singular, plural] of [
    ["CT", "pack", "packs"],
    ["PCE", "piece", "pieces"],
    ["LTR", "litre", "litres"],
    ["KGM", "kilogram", "kilograms"],
    ["BAG", "bag", "bags"],
    ["BOT", "bottle", "bottles"],
    ["CS", "case", "cases"],
    ["DSP", "display", "displays"],
    ["DZ", "dozen", "dozen"],
    ["KG", "kilogram", "kilograms"],
    ["KI", "case", "cases"],
    ["KRT", "carton", "cartons"],
    ["NIP", "bundle", "bundles"],
    ["PAK", "package", "packages"],
    ["PAL", "pallet", "pallets"],
    ["RAS", "tub", "tubs"],
    ["ST", "piece", "pieces"],
    ["GRM", "gram", "grams"],
    ["CLT", "centilitre", "centilitres"],
    ["MLT", "millilitre", "millilitres"],
  ] as const) {
    test(unit, () => {
      expect(formatQuantity({ value: 1, unit })).toBe(`1 ${singular}`);
      expect(formatQuantity({ value: 2, unit })).toBe(`2 ${plural}`);
      expect(formatQuantity({ value: 0.5, unit })).toBe(
        `${new Intl.NumberFormat("en-FI").format(0.5)} ${plural}`,
      );
    });
  }
  test("unknown and missing codes are not exposed", () => {
    for (const unit of ["KLE", "KAN", "PRK", "SK", "SOME_SECRET_CODE", "", "toString"])
      expect(formatQuantity({ value: 3, unit })).toBe("3 (unit unknown)");
    expect(formatQuantity({ value: NaN, unit: "CT" })).toBe("Quantity unavailable");
  });
});

test("order numbers are bounded and retain short identifiers", () => {
  expect(formatOrderNumber("")).toBe("Order number unavailable");
  expect(formatOrderNumber("abc")).toBe("abc");
  expect(formatOrderNumber("12345678-1234-1234-1234-123456789abc")).toBe("12345678");
});
