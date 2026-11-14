import { describe, expect, test } from "bun:test";
import type { AvailabilityQuote, HardConstraint } from "@app/contract";
import {
  availabilityOmitReason,
  batchIds,
  checkQuantity,
  contradictedAttribute,
  deliveryOnRequestedDate,
  expiredOmitReason,
  isDeliverableBy,
  lineTotal,
  mergeConstraints,
  priceCacheExpiry,
  offerExpiry,
} from "./offer-rules.ts";

const now = new Date("2026-11-14T10:00:00Z");
const lactose: HardConstraint = { attribute: "lactose", is: "free_from" };

const availability = (patch: Partial<AvailabilityQuote> = {}): AvailabilityQuote => ({
  productId: "p1",
  amount: 10,
  availableDate: "2026-11-15",
  nextDeliveryDate: null,
  cutoffAt: null,
  salesBlocked: false,
  stock: "confirmed",
  ...patch,
});

describe("gross = (net × (1 + vatRate/100) + deposit) × quantity", () => {
  test("gross = (net × (1 + vatRate/100) + deposit) × quantity with no deposit", () => {
    expect(lineTotal({ net: 14.4, vatRate: 14 }, 0, 4)).toEqual({
      total: { net: 57.6, gross: 65.66 },
      deposits: 0,
    });
  });

  test("gross = (net × (1 + vatRate/100) + deposit) × quantity rounds to cents with a deposit", () => {
    // (14.4 × 1.14 + 0.1) × 4 = 66.064
    expect(lineTotal({ net: 14.4, vatRate: 14 }, 0.1, 4).total.gross).toBe(66.06);
    expect(lineTotal({ net: 2.135, vatRate: 0 }, 0, 1).total.gross).toBe(2.14);
    expect(lineTotal({ net: 17.15, vatRate: 10 }, 0, 1).total.gross).toBe(18.87);
    expect(lineTotal({ net: 1.15, vatRate: 10 }, 0, 7).total.gross).toBe(8.86);
  });

  test("deposits = deposit × quantity", () => {
    expect(lineTotal({ net: 2, vatRate: 14 }, 0.1, 6).deposits).toBe(0.6);
  });
});

describe("offer expiry", () => {
  test("exp is the earlier of validTo and cutoffAt", () => {
    const validTo = "2026-11-14T12:00:00Z";
    expect(offerExpiry(validTo, "2026-11-14T11:00:00Z")).toEqual(new Date("2026-11-14T11:00:00Z"));
    expect(offerExpiry(validTo, "2026-11-14T13:00:00Z")).toEqual(new Date(validTo));
    expect(offerExpiry(validTo, null)).toEqual(new Date(validTo));
  });

  test("an expired cutoffAt is omitted NO_DELIVERY_DATE and an expired validTo NO_PRICE; cut-off takes precedence", () => {
    const past = "2026-11-14T09:00:00Z";
    const future = "2026-11-14T11:00:00Z";
    expect(expiredOmitReason(future, past, now)).toBe("NO_DELIVERY_DATE");
    expect(expiredOmitReason(past, future, now)).toBe("NO_PRICE");
    expect(expiredOmitReason(past, past, now)).toBe("NO_DELIVERY_DATE");
    expect(expiredOmitReason("2026-11-14T10:00:00Z", null, now)).toBe("NO_PRICE");
    expect(expiredOmitReason(future, null, now)).toBeNull();
    expect(expiredOmitReason(future, future, now)).toBeNull();
  });
});

describe("quantity", () => {
  test("quantity 0, a negative or a non-integer multiple of allowedLotSize, or a unit other than the sales unit is omitted INVALID_QUANTITY", () => {
    const lots = { salesUnit: "PCE", allowedLotSize: 6 };
    expect(checkQuantity({ value: 0, unit: "PCE" }, lots)).toBe("INVALID_QUANTITY");
    expect(checkQuantity({ value: -6, unit: "PCE" }, lots)).toBe("INVALID_QUANTITY");
    expect(checkQuantity({ value: 7, unit: "PCE" }, lots)).toBe("INVALID_QUANTITY");
    expect(checkQuantity({ value: 6, unit: "KGM" }, lots)).toBe("INVALID_QUANTITY");
    expect(checkQuantity({ value: Number.NaN, unit: "PCE" }, lots)).toBe("INVALID_QUANTITY");
    expect(checkQuantity({ value: 12, unit: "PCE" }, lots)).toBeNull();
  });

  test("INVALID_QUANTITY: a quantity within tolerance of zero lots is invalid", () => {
    expect(
      checkQuantity({ value: 1e-10, unit: "PCE" }, { salesUnit: "PCE", allowedLotSize: 1 }),
    ).toBe("INVALID_QUANTITY");
  });

  test("INVALID_QUANTITY regression: 111913.18 KG with lot size 0.01 is valid", () => {
    const facts = { salesUnit: "KGM", allowedLotSize: 0.01 };
    expect(checkQuantity({ value: 111913.18, unit: "KGM" }, facts)).toBeNull();
    expect(checkQuantity({ value: 111913.185, unit: "KGM" }, facts)).toBe("INVALID_QUANTITY");
  });

  test("INVALID_QUANTITY regression: 1e308 is refused", () => {
    const facts = { salesUnit: "PCE", allowedLotSize: 1 };
    expect(checkQuantity({ value: 1e308, unit: "PCE" }, facts)).toBe("INVALID_QUANTITY");
    expect(checkQuantity({ value: 2 ** 53, unit: "PCE" }, facts)).toBe("INVALID_QUANTITY");
    expect(checkQuantity({ value: Number.MAX_SAFE_INTEGER, unit: "PCE" }, facts)).toBeNull();
  });

  test("INVALID_QUANTITY regression: 0.3 with lot size 0.1 is valid", () => {
    expect(
      checkQuantity({ value: 0.3, unit: "KGM" }, { salesUnit: "KGM", allowedLotSize: 0.1 }),
    ).toBeNull();
  });
});

test("advancing preserves Helsinki wall time across DST and discards a stale next slot", () => {
  const quote = availability({
    availableDate: "2027-03-27",
    nextDeliveryDate: "2027-03-28",
    cutoffAt: "2027-03-26T15:30:00Z",
  });
  expect(deliveryOnRequestedDate(quote, "2027-03-29")).toMatchObject({
    availableDate: "2027-03-29",
    nextDeliveryDate: null,
    cutoffAt: "2027-03-28T17:30:00.000+03:00",
    stock: "unconfirmed",
  });
  expect(deliveryOnRequestedDate(quote, "2027-03-27")).toBe(quote);
  expect(deliveryOnRequestedDate(quote, "2027-03-26")).toBe(quote);
});

const cutoffDeliverable = (cutoffAt: string) =>
  isDeliverableBy(availability({ cutoffAt }), "2026-11-15", now);

describe("isDeliverableBy", () => {
  test("a delivery date on or before the requested date is deliverable, a later one is not", () => {
    expect(isDeliverableBy(availability(), "2026-11-15", now)).toBe(true);
    expect(isDeliverableBy(availability(), "2026-11-18", now)).toBe(true);
    expect(isDeliverableBy(availability({ availableDate: "2026-11-16" }), "2026-11-15", now)).toBe(
      false,
    );
  });

  test("no quote, no delivery date and a sales block are not deliverable", () => {
    expect(isDeliverableBy(undefined, "2026-11-15", now)).toBe(false);
    expect(isDeliverableBy(availability({ availableDate: null }), "2026-11-15", now)).toBe(false);
    expect(isDeliverableBy(availability({ salesBlocked: true }), "2026-11-15", now)).toBe(false);
  });

  test("a cut-off at or before now is not deliverable, a later one is", () => {
    expect(cutoffDeliverable("2026-11-14T10:00:00Z")).toBe(false);
    expect(cutoffDeliverable("2026-11-14T09:59:59Z")).toBe(false);
    expect(cutoffDeliverable("2026-11-14T10:00:01Z")).toBe(true);
  });

  test("stock below any quantity stays deliverable: partial stock still gets an offer", () => {
    expect(isDeliverableBy(availability({ amount: 0 }), "2026-11-15", now)).toBe(true);
  });
});

describe("availability", () => {
  test("confirmed amount below the request is omitted INSUFFICIENT_STOCK", () => {
    expect(availabilityOmitReason(availability({ amount: 3 }), 4)).toBe("INSUFFICIENT_STOCK");
    expect(availabilityOmitReason(availability({ amount: 4 }), 4)).toBeNull();
  });

  test("unconfirmed stock below the request is not omitted INSUFFICIENT_STOCK", () => {
    expect(
      availabilityOmitReason(availability({ amount: 999999, stock: "unconfirmed" }), 4),
    ).toBeNull();
    expect(availabilityOmitReason(availability({ amount: 1, stock: "unconfirmed" }), 4)).toBeNull();
  });

  test("no price, a sales block or no date is omitted NO_PRICE, SALES_BLOCKED, NO_DELIVERY_DATE", () => {
    expect(availabilityOmitReason(availability({ salesBlocked: true }), 1)).toBe("SALES_BLOCKED");
    expect(availabilityOmitReason(availability({ availableDate: null }), 1)).toBe(
      "NO_DELIVERY_DATE",
    );
    expect(availabilityOmitReason(undefined, 1)).toBe("NO_DELIVERY_DATE");
    // precedence: sales block, then no date, then stock
    expect(
      availabilityOmitReason(
        availability({ salesBlocked: true, availableDate: null, amount: 0 }),
        1,
      ),
    ).toBe("SALES_BLOCKED");
    expect(availabilityOmitReason(availability({ availableDate: null, amount: 0 }), 1)).toBe(
      "NO_DELIVERY_DATE",
    );
  });
});

describe("constraints", () => {
  test("merged constraints are the union of request and mandate without duplicates", () => {
    const soft = { attribute: "origin", prefer: "FI" };
    const merged = mergeConstraints(
      { hard: [lactose], soft: [soft] },
      { hard: [lactose], soft: [soft, { attribute: "organic", prefer: "yes" }] },
    );
    expect(merged.hard).toEqual([lactose]);
    expect(merged.soft).toEqual([soft, { attribute: "organic", prefer: "yes" }]);
    expect(mergeConstraints({ hard: [lactose], soft: [] }, null)).toEqual({
      hard: [lactose],
      soft: [],
    });
  });

  test("merged constraints: a contradicted match on a merged hard constraint is found", () => {
    expect(contradictedAttribute({ lactose: "contradicted" }, [lactose])).toBe("lactose");
    expect(contradictedAttribute({ lactose: "confirmed" }, [lactose])).toBeNull();
    expect(contradictedAttribute({ lactose: "unknown" }, [lactose])).toBeNull();
    expect(contradictedAttribute({ lactose: "contradicted" }, [])).toBeNull();
  });
});

describe("batchIds", () => {
  test("batchIds deduplicates and splits 1,001 ids into 1,000 and 1", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `p${i}`);
    const batches = batchIds([...ids, "p0", "p5"]);
    expect(batches.map((b) => b.length)).toEqual([1000, 1]);
    expect(batches.flat()).toEqual(ids);
  });

  test("batchIds throws for a max that is not a positive integer", () => {
    expect(() => batchIds(["a"], 0)).toThrow(RangeError);
    expect(() => batchIds(["a"], -1)).toThrow(RangeError);
    expect(() => batchIds(["a"], 1.5)).toThrow(RangeError);
  });

  test("batchIds honours a smaller max", () => {
    expect(batchIds(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(batchIds([])).toEqual([]);
  });
});

describe("priceCacheExpiry", () => {
  const lookedUpAt = new Date("2026-11-14T10:00:00Z");

  test("caps the price cache at 5 minutes after the lookup", () => {
    expect(
      priceCacheExpiry("9999-12-31T00:00:00+02:00", "2026-11-15T17:00:00+02:00", lookedUpAt),
    ).toEqual(new Date("2026-11-14T10:05:00Z"));
  });

  test("ends the price cache at an earlier cut-off or validTo", () => {
    expect(
      priceCacheExpiry("9999-12-31T00:00:00+02:00", "2026-11-14T10:02:00Z", lookedUpAt),
    ).toEqual(new Date("2026-11-14T10:02:00Z"));
    expect(priceCacheExpiry("2026-11-14T10:01:00Z", null, lookedUpAt)).toEqual(
      new Date("2026-11-14T10:01:00Z"),
    );
  });
});
