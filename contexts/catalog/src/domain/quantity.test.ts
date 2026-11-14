import { describe, expect, test } from "bun:test";
import { isValidQuantity, MAX_QUANTITY, perSalesUnit, toOrderQuantity } from "./quantity.ts";

describe("quantity conversion", () => {
  test("1000 LTR of a 1 l item, 10 per sales unit, gives 100 sales units", () => {
    const per = perSalesUnit({ value: 1, unit: "LTR" }, 10);
    expect(per).toEqual({ value: 10, unit: "LTR" });
    expect(
      toOrderQuantity(
        { value: 1000, unit: "LTR" },
        { salesUnit: "KI", allowedLotSize: 1, perSalesUnit: per },
      ),
    ).toEqual({ orderQuantity: { value: 100, unit: "KI" }, equals: { value: 1000, unit: "LTR" } });
  });

  test("rounds up to allowedLotSize", () => {
    const product = {
      salesUnit: "KI",
      allowedLotSize: 2,
      perSalesUnit: { value: 10, unit: "LTR" },
    };
    expect(toOrderQuantity({ value: 1005, unit: "LTR" }, product)).toEqual({
      orderQuantity: { value: 102, unit: "KI" },
      equals: { value: 1020, unit: "LTR" },
    });
    const fine = { salesUnit: "ST", allowedLotSize: 0.01, perSalesUnit: { value: 3, unit: "LTR" } };
    expect(toOrderQuantity({ value: 1000, unit: "LTR" }, fine).orderQuantity).toEqual({
      value: 334,
      unit: "ST",
    });
    const exact = {
      salesUnit: "ST",
      allowedLotSize: 0.01,
      perSalesUnit: { value: 1, unit: "LTR" },
    };
    expect(toOrderQuantity({ value: 1000, unit: "LTR" }, exact).orderQuantity).toEqual({
      value: 1000,
      unit: "ST",
    });
  });

  test("GRM converts to KGM", () => {
    const per = perSalesUnit({ value: 500, unit: "GRM" }, 6);
    expect(per).toEqual({ value: 3, unit: "KGM" });
    expect(
      toOrderQuantity(
        { value: 30000, unit: "GRM" },
        { salesUnit: "KI", allowedLotSize: 1, perSalesUnit: per },
      ),
    ).toEqual({ orderQuantity: { value: 10, unit: "KI" }, equals: { value: 30, unit: "KGM" } });
  });

  test("no volume gives null", () => {
    expect(perSalesUnit(null, 10)).toBeNull();
    expect(perSalesUnit({ value: 1, unit: "H87" }, 10)).toBeNull();
    expect(
      toOrderQuantity(
        { value: 1000, unit: "LTR" },
        { salesUnit: "KI", allowedLotSize: 1, perSalesUnit: null },
      ),
    ).toEqual({
      orderQuantity: null,
      equals: null,
      quantityReason: "Sales unit conversion is unavailable.",
    });
  });

  test("a requested unit of another dimension gives null", () => {
    const product = { salesUnit: "KI", allowedLotSize: 1, perSalesUnit: { value: 3, unit: "KGM" } };
    expect(toOrderQuantity({ value: 1000, unit: "LTR" }, product)).toEqual({
      orderQuantity: null,
      equals: null,
      quantityReason: "Requested unit is incompatible with the sales unit.",
    });
  });

  test("a quantity in the sales unit rounds up and states the std equivalent", () => {
    const product = { salesUnit: "KI", allowedLotSize: 4, perSalesUnit: { value: 6, unit: "LTR" } };
    expect(toOrderQuantity({ value: 5, unit: "KI" }, product)).toEqual({
      orderQuantity: { value: 8, unit: "KI" },
      equals: { value: 48, unit: "LTR" },
    });
  });

  test("a request just above a lot boundary rounds up and never underfills", () => {
    const product = {
      salesUnit: "KI",
      allowedLotSize: 1,
      perSalesUnit: { value: 10, unit: "LTR" },
    };
    expect(toOrderQuantity({ value: 1000.000004, unit: "LTR" }, product)).toEqual({
      orderQuantity: { value: 101, unit: "KI" },
      equals: { value: 1010, unit: "LTR" },
    });
    expect(toOrderQuantity({ value: 0.000004, unit: "LTR" }, product).orderQuantity).toEqual({
      value: 1,
      unit: "KI",
    });
    const noisy = { salesUnit: "ST", allowedLotSize: 0.1, perSalesUnit: { value: 1, unit: "LTR" } };
    expect(toOrderQuantity({ value: 0.3, unit: "LTR" }, noisy).orderQuantity).toEqual({
      value: 1,
      unit: "ST",
    });
  });

  test("a valid quantity is finite, above 0 and at most MAX_QUANTITY", () => {
    expect(isValidQuantity({ value: 0.001, unit: "LTR" })).toBe(true);
    expect(isValidQuantity({ value: MAX_QUANTITY, unit: "LTR" })).toBe(true);
    expect(isValidQuantity({ value: 0, unit: "LTR" })).toBe(false);
    expect(isValidQuantity({ value: -1, unit: "LTR" })).toBe(false);
    expect(isValidQuantity({ value: MAX_QUANTITY * 10, unit: "LTR" })).toBe(false);
    expect(isValidQuantity({ value: 1e303, unit: "LTR" })).toBe(false);
  });

  test("a conversion that would overflow gives null, not Infinity", () => {
    const tiny = {
      salesUnit: "ST",
      allowedLotSize: 1e-300,
      perSalesUnit: { value: 1e-10, unit: "LTR" },
    };
    expect(toOrderQuantity({ value: 1e303, unit: "LTR" }, tiny)).toEqual({
      orderQuantity: null,
      equals: null,
      quantityReason: "Quantity conversion exceeds supported precision.",
    });
  });

  test("count lots use the smallest compatible whole sales-unit step", () => {
    const cases: [number, number, number][] = [
      [0.01, 2.1, 3],
      [0.4, 3, 4],
      [1.5, 4, 6],
      [2.5, 6, 10],
    ];
    for (const [lot, requested, expected] of cases) {
      const product = {
        salesUnit: "ST",
        allowedLotSize: lot,
        perSalesUnit: { value: 1, unit: "LTR" },
      };
      expect(toOrderQuantity({ value: requested, unit: "LTR" }, product).orderQuantity).toEqual({
        value: expected,
        unit: "ST",
      });
    }
    for (const salesUnit of [
      "BAG",
      "BOT",
      "CS",
      "DSP",
      "DZ",
      "KAN",
      "KI",
      "KLE",
      "KRT",
      "NIP",
      "PAK",
      "PAL",
      "PRK",
      "RAS",
      "SK",
      "ST",
      "H87",
      "PCE",
      "EA",
      "PK",
    ]) {
      expect(
        toOrderQuantity(
          { value: 1.2, unit: salesUnit },
          {
            salesUnit,
            allowedLotSize: 0.01,
            perSalesUnit: { value: 1, unit: "LTR" },
          },
        ).orderQuantity,
      ).toEqual({ value: 2, unit: salesUnit });
    }
  });

  test("weight lots retain fractions and precise boundaries do not underfill", () => {
    const product = {
      salesUnit: "KGM",
      allowedLotSize: 0.01,
      perSalesUnit: { value: 1, unit: "KGM" },
    };
    expect(toOrderQuantity({ value: 1.234, unit: "KGM" }, product).orderQuantity).toEqual({
      value: 1.24,
      unit: "KGM",
    });
    const count = { salesUnit: "ST", allowedLotSize: 1, perSalesUnit: { value: 1, unit: "LTR" } };
    expect(toOrderQuantity({ value: 1000000.000001, unit: "LTR" }, count).orderQuantity).toEqual({
      value: 1000001,
      unit: "ST",
    });
  });

  test("invalid and unrepresentable conversions return a reason", () => {
    const product = { salesUnit: "ST", allowedLotSize: 1, perSalesUnit: { value: 1, unit: "LTR" } };
    for (const value of [0, -1, Infinity, NaN, Number.MAX_VALUE]) {
      const result = toOrderQuantity({ value, unit: "LTR" }, product);
      expect(result.orderQuantity).toBeNull();
      expect(result.equals).toBeNull();
      expect(result.quantityReason).toBeTruthy();
    }
    expect(perSalesUnit({ value: Infinity, unit: "LTR" }, 1)).toBeNull();
    expect(perSalesUnit({ value: Number.MAX_VALUE, unit: "LTR" }, 2)).toBeNull();
    expect(perSalesUnit({ value: 1, unit: "LTR" }, Infinity)).toBeNull();
    expect(
      toOrderQuantity({ value: 1, unit: "LTR" }, { ...product, allowedLotSize: 0 }).quantityReason,
    ).toBeTruthy();
    expect(toOrderQuantity({ value: 1, unit: "LTR" }, product).quantityReason).toBeUndefined();
  });
});
