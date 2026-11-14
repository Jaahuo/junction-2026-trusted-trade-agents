import { describe, expect, test } from "bun:test";
import { DemoProductsSchema } from "../packages/contract/src/index.ts";
import { mapRow, validateCandidates } from "./check-demo-data";

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
});
