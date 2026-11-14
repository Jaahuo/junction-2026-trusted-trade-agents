import { describe, expect, test } from "bun:test";
import { isPositiveQuantity, perSalesUnit, toOrderQuantity } from "./quantity.ts";

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
      value: 333.34,
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
    ).toEqual({ orderQuantity: null, equals: null });
  });

  test("a requested unit of another dimension gives null", () => {
    const product = { salesUnit: "KI", allowedLotSize: 1, perSalesUnit: { value: 3, unit: "KGM" } };
    expect(toOrderQuantity({ value: 1000, unit: "LTR" }, product)).toEqual({
      orderQuantity: null,
      equals: null,
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
      value: 0.3,
      unit: "ST",
    });
  });

  test("only a finite quantity above 0 is positive", () => {
    expect(isPositiveQuantity({ value: 0.001, unit: "LTR" })).toBe(true);
    expect(isPositiveQuantity({ value: 0, unit: "LTR" })).toBe(false);
    expect(isPositiveQuantity({ value: -1, unit: "LTR" })).toBe(false);
  });
});
