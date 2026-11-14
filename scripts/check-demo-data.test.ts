import { describe, expect, test } from "bun:test";
import { DemoProductsSchema } from "../packages/contract/src/index.ts";
import {
  isLate,
  isShortWithSubstitute,
  mapRow,
  parseArgs,
  salesUnits,
  validateCandidates,
} from "./check-demo-data";

const row = (overrides: Partial<Parameters<typeof isShortWithSubstitute>[0]["row"]> = {}) => ({
  productId: "synthetic",
  amount: 10,
  date: "2026-11-16",
  stock: "confirmed" as const,
  net: 1,
  gross: 2,
  comparison: null,
  comparisonUnit: null,
  volume: null,
  substitutes: ["synthetic-sub"],
  ...overrides,
});
const substitute = row({ productId: "synthetic-sub", substitutes: [] });
const check = (r: ReturnType<typeof row>, units: number, substitutes = [substitute]) =>
  isShortWithSubstitute({ row: r, units, substitutes, date: "2026-11-16" });

describe("demo data checker", () => {
  test("maps a recorded availability and price response in the documented shape to a row with amount, date, stock and net price", () => {
    const availability = [
      {
        productId: "synthetic",
        salesBlock: false,
        closingTime: null,
        scheduleLines: [
          { availableAmount: 42, availableDate: "2026-11-16", salesBlock: false, salesUnit: "ST" },
        ],
      },
    ];
    const prices = [
      {
        productId: "synthetic",
        quantity: 1,
        netPriceFound: true,
        error: false,
        catalogPrice: {
          value: 3,
          valueWithTax: 3.42,
          currency: "EUR",
          validFrom: "2026-11-01",
          validTo: "2026-12-01",
        },
        comparisonPrice: null,
      },
    ];
    expect(mapRow("synthetic", availability, prices)).toMatchObject({
      amount: 42,
      date: "2026-11-16",
      stock: "confirmed",
      net: 3,
      gross: 3.42,
    });
    expect(
      mapRow(
        "synthetic",
        [
          {
            productId: "synthetic",
            salesBlock: false,
            scheduleLines: [
              { availableAmount: 999999, availableDate: "2026-11-16", salesBlock: false },
            ],
          },
        ],
        prices,
      ).stock,
    ).toBe("unconfirmed");
    expect(
      mapRow("synthetic", [{ productId: "synthetic", salesBlock: true, scheduleLines: [] }], prices)
        .stock,
    ).toBe("unavailable");
  });
  test("refuses to run with more than 40 candidate ids", () => {
    expect(() => validateCandidates(Array.from({ length: 41 }, (_, i) => String(i)))).toThrow(
      "40 candidate ids",
    );
    expect(() => validateCandidates(Array.from({ length: 40 }, (_, i) => String(i)))).not.toThrow();
  });
  test("validates scenario shape and rejects extra dataset values", () => {
    const scenario = { productId: "synthetic", quantity: { value: 20, unit: "LTR" } };
    const demo = {
      observedAt: "2026-11-14T08:00:00Z",
      requestedDate: "2026-11-16",
      s1: scenario,
      s2: scenario,
      s3: null,
      late: null,
      triedForS3: [],
    };
    expect(DemoProductsSchema.safeParse(demo).success).toBe(true);
    expect(DemoProductsSchema.safeParse({ ...demo, s1: { ...scenario, price: 2 } }).success).toBe(
      false,
    );
    expect(
      DemoProductsSchema.safeParse({
        ...demo,
        s2: { ...scenario, quantity: { value: "20", unit: "LTR" } },
      }).success,
    ).toBe(false);
  });

  test("S3 holds for confirmed stock below the request with an orderable substitute under the credit limit", () => {
    expect(check(row(), 12)).toBe(true);
  });

  test("S3 fails for enough stock, unlimited stock, no orderable substitute or a total over the credit limit", () => {
    expect(check(row(), 10)).toBe(false);
    expect(check(row({ amount: 999999, stock: "unconfirmed" }), 12)).toBe(false);
    expect(check(row({ amount: 9999999999 }), 12)).toBe(false);
    expect(check(row(), 12, [])).toBe(false);
    expect(check(row(), 12, [{ ...substitute, gross: null }])).toBe(false);
    expect(check(row(), 12, [{ ...substitute, date: "2026-11-17" }])).toBe(false);
    expect(check(row({ gross: 500 }), 12)).toBe(false);
    expect(check(row({ substitutes: [] }), 12)).toBe(false);
  });

  test("LATE holds only when the first open date is after the requested date", () => {
    expect(isLate({ date: "2026-11-17" }, "2026-11-16")).toBe(true);
    expect(isLate({ date: "2026-11-16" }, "2026-11-16")).toBe(false);
    expect(isLate({ date: null }, "2026-11-16")).toBe(false);
  });

  test("salesUnits passes the sales unit through and converts litres by volume", () => {
    expect(salesUnits({ value: 7, unit: "ST" }, { volume: null }, "ST")).toBe(7);
    expect(salesUnits({ value: 20, unit: "LTR" }, { volume: 2 }, "KI")).toBe(10);
    expect(salesUnits({ value: 1, unit: "KGM" }, { volume: null }, "ST")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test("parseArgs takes a date and an optional id list, and rejects anything else", () => {
    expect(parseArgs(["--date", "2026-11-16"]).date).toBe("2026-11-16");
    expect(parseArgs(["--date", "2026-11-16", "--ids", "a,b"]).ids).toEqual(["a", "b"]);
    expect(() => parseArgs(["--date", "16.11.2026"])).toThrow("Usage");
    expect(() => parseArgs(["--date"])).toThrow("Usage");
    expect(() => parseArgs(["--other", "x", "--date", "2026-11-16"])).toThrow("Usage");
  });
});
