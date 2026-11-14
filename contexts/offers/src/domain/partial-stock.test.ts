import { describe, expect, test } from "bun:test";
import type { ProductFacts } from "@app/contract";
import {
  floorToLot,
  planOriginalQuantity,
  pricePerStdUnit,
  quantityForShortfall,
  rankSubstitutes,
  stockCovers,
  type QuotedProduct,
} from "./partial-stock.ts";

const product = (patch: Partial<ProductFacts> = {}): ProductFacts => ({
  productId: "original",
  gtin: null,
  name: "Milk",
  category: "dairy",
  salesUnit: "CASE",
  allowedLotSize: 1,
  perSalesUnit: { value: 2, unit: "LTR" },
  countryOfOrigin: "fi",
  deliveryReliability: 0.9,
  co2PerKg: 1,
  match: {},
  substitutes: [],
  ...patch,
});
const quoted = (id: string, net: number, patch: Partial<ProductFacts> = {}): QuotedProduct => ({
  product: product({ productId: id, ...patch }),
  price: {
    productId: id,
    unitPrice: { net, vatRate: 14, currency: "EUR" },
    deposit: 0,
    comparisonPrice: null,
    validTo: "2026-11-15T00:00:00Z",
  },
});

describe("partial stock quantities", () => {
  test("floors fractional lots with floating point tolerance and rejects unsafe values", () => {
    expect(floorToLot(0.3, 0.1)).toBeCloseTo(0.3);
    expect(floorToLot(0.29, 0.1)).toBeCloseTo(0.2);
    expect(floorToLot(0, 1)).toBe(0);
    expect(floorToLot(Infinity, 1)).toBeNull();
    expect(floorToLot(1, 0)).toBeNull();
    expect(floorToLot(Number.MAX_SAFE_INTEGER, 0.1)).toBeNull();
  });
  test("plans confirmed stock, signs standard-unit shortfall and preserves unconfirmed quantity", () => {
    const requested = { value: 10, unit: "CASE" };
    expect(planOriginalQuantity(requested, product(), { stock: "confirmed", amount: 3.9 })).toEqual(
      {
        ok: true,
        value: { quantity: { value: 3, unit: "CASE" }, shortfall: { value: 14, unit: "LTR" } },
      },
    );
    expect(
      planOriginalQuantity(requested, product({ perSalesUnit: null }), {
        stock: "confirmed",
        amount: 3,
      }),
    ).toEqual({
      ok: true,
      value: { quantity: { value: 3, unit: "CASE" }, shortfall: { value: 7, unit: "CASE" } },
    });
    expect(
      planOriginalQuantity(requested, product(), { stock: "unconfirmed", amount: NaN }),
    ).toEqual({ ok: true, value: { quantity: requested, shortfall: null } });
    expect(planOriginalQuantity(requested, product(), { stock: "confirmed", amount: 0.5 })).toEqual(
      { ok: false, error: "INSUFFICIENT_STOCK" },
    );
    expect(
      planOriginalQuantity({ value: 1.5, unit: "CASE" }, product(), {
        stock: "confirmed",
        amount: 2,
      }),
    ).toEqual({ ok: false, error: "INVALID_QUANTITY" });
    expect(
      planOriginalQuantity(requested, product({ perSalesUnit: { value: 0, unit: "LTR" } }), {
        stock: "confirmed",
        amount: 3,
      }),
    ).toEqual({ ok: false, error: "INVALID_QUANTITY" });
  });
  test("rounds up to full coverage and refuses incompatible or unknown conversions", () => {
    const original = product();
    const substitute = product({
      salesUnit: "PACK",
      allowedLotSize: 0.5,
      perSalesUnit: { value: 3, unit: "LTR" },
    });
    expect(quantityForShortfall({ value: 7, unit: "LTR" }, original, substitute)).toEqual({
      value: 2.5,
      unit: "PACK",
    });
    expect(quantityForShortfall({ value: 7, unit: "KGM" }, original, substitute)).toBeNull();
    expect(
      quantityForShortfall({ value: 7, unit: "LTR" }, original, product({ perSalesUnit: null })),
    ).toBeNull();
    expect(
      quantityForShortfall(
        { value: 7, unit: "LTR" },
        original,
        product({ perSalesUnit: { value: 1, unit: "KGM" } }),
      ),
    ).toBeNull();
    const noConversion = product({ perSalesUnit: null });
    expect(quantityForShortfall({ value: 2.1, unit: "CASE" }, noConversion, product())).toEqual({
      value: 3,
      unit: "CASE",
    });
    expect(quantityForShortfall({ value: 2, unit: "CASE" }, noConversion, substitute)).toBeNull();
    expect(
      quantityForShortfall({ value: Infinity, unit: "CASE" }, noConversion, product()),
    ).toBeNull();
  });
  test("normalizes arithmetic noise at lot boundaries without ignoring genuine excess", () => {
    const original = product({ perSalesUnit: { value: 0.1, unit: "LTR" } });
    const planned = planOriginalQuantity({ value: 4, unit: "CASE" }, original, {
      stock: "confirmed",
      amount: 1,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok || planned.value.shortfall === null) throw new Error("Expected shortfall");
    const substitute = product({ perSalesUnit: { value: 0.1, unit: "LTR" } });
    expect(quantityForShortfall(planned.value.shortfall, original, substitute)).toEqual({
      value: 3,
      unit: "CASE",
    });
    const fractional = product({
      salesUnit: "PACK",
      allowedLotSize: 0.5,
      perSalesUnit: { value: 0.2, unit: "LTR" },
    });
    expect(quantityForShortfall(planned.value.shortfall, original, fractional)).toEqual({
      value: 1.5,
      unit: "PACK",
    });
    expect(quantityForShortfall({ value: 0.3, unit: "LTR" }, original, fractional)).toEqual({
      value: 1.5,
      unit: "PACK",
    });
    expect(quantityForShortfall({ value: 0.3 + 1e-12, unit: "LTR" }, original, fractional)).toEqual(
      { value: 2, unit: "PACK" },
    );
    expect(
      quantityForShortfall({ value: Number.MAX_SAFE_INTEGER, unit: "LTR" }, original, fractional),
    ).toBeNull();
  });
  test("generated decimal lot rules agree with a scaled-integer oracle", () => {
    const scale = 1000;
    for (const lotTicks of [100, 250, 500, 1000]) {
      const lot = lotTicks / scale;
      for (const count of [1, 3, 7, 25]) {
        for (const extraTicks of [0, Math.floor(lotTicks / 3)]) {
          const stockTicks = count * lotTicks + extraTicks;
          const requestedTicks = (count + 2) * lotTicks;
          const availableTicks = Math.floor(stockTicks / lotTicks) * lotTicks;
          const item = product({ allowedLotSize: lot, perSalesUnit: null });
          const plan = planOriginalQuantity({ value: requestedTicks / scale, unit: "CASE" }, item, {
            stock: "confirmed",
            amount: stockTicks / scale,
          });
          expect(plan.ok).toBe(true);
          if (!plan.ok || plan.value.shortfall === null) throw new Error("Expected shortfall");
          expect(plan.value.quantity.value).toBeCloseTo(availableTicks / scale, 10);
          expect(plan.value.shortfall.value).toBeCloseTo(
            (requestedTicks - availableTicks) / scale,
            10,
          );
          expect(stockCovers(stockTicks / scale, availableTicks / scale, lot)).toBe(true);
          expect(stockCovers(stockTicks / scale, (availableTicks + lotTicks) / scale, lot)).toBe(
            false,
          );
        }
        for (const conversionTicks of [100, 250, 1000]) {
          for (const excessTicks of [0, 1]) {
            // Standard amounts use integer millionths so the oracle stays integral.
            const standardTicks = count * lotTicks * conversionTicks + excessTicks * scale;
            const expectedLots = Math.ceil(standardTicks / (lotTicks * conversionTicks));
            const substitute = product({
              salesUnit: "PACK",
              allowedLotSize: lot,
              perSalesUnit: { value: conversionTicks / scale, unit: "LTR" },
            });
            const quantity = quantityForShortfall(
              { value: standardTicks / (scale * scale), unit: "LTR" },
              product(),
              substitute,
            );
            expect(quantity).not.toBeNull();
            expect(quantity?.value).toBeCloseTo((expectedLots * lotTicks) / scale, 10);
          }
        }
      }
    }
    for (const count of [100000000000, 600000000000]) {
      const stockTicks = count * scale + 600;
      const requestedTicks = (count + 1) * scale;
      const availableTicks = Math.floor(stockTicks / scale) * scale;
      const plan = planOriginalQuantity(
        { value: requestedTicks / scale, unit: "CASE" },
        product({ perSalesUnit: null }),
        { stock: "confirmed", amount: stockTicks / scale },
      );
      expect(plan).toEqual({
        ok: true,
        value: {
          quantity: { value: availableTicks / scale, unit: "CASE" },
          shortfall: { value: (requestedTicks - availableTicks) / scale, unit: "CASE" },
        },
      });
      expect(stockCovers(stockTicks / scale, requestedTicks / scale, 1)).toBe(false);
      expect(
        quantityForShortfall(
          { value: (count * scale + 600) / scale, unit: "CASE" },
          product({ perSalesUnit: null }),
          product({ perSalesUnit: null }),
        ),
      ).toEqual({ value: count + 1, unit: "CASE" });
    }
    expect(stockCovers(0.3, 3 * 0.1, 0.1)).toBe(true);
    expect(stockCovers(0.3, 0.3 + 1e-10, 0.1)).toBe(false);
    expect(stockCovers(NaN, 1, 1)).toBe(false);
    expect(stockCovers(1, Infinity, 1)).toBe(false);
    expect(stockCovers(1, 1, 0)).toBe(false);
    expect(stockCovers(Number.MAX_SAFE_INTEGER, 1, 0.1)).toBe(false);
    expect(floorToLot(600000000000.6, 1)).toBe(600000000000);
    expect(
      planOriginalQuantity({ value: 600000000001, unit: "CASE" }, product({ perSalesUnit: null }), {
        stock: "confirmed",
        amount: 600000000000.6,
      }),
    ).toEqual({
      ok: true,
      value: {
        quantity: { value: 600000000000, unit: "CASE" },
        shortfall: { value: 1, unit: "CASE" },
      },
    });
  });
  test("composes decimal stock planning and substitution against integer lot arithmetic", () => {
    const original = product({ allowedLotSize: 0.1, perSalesUnit: { value: 1, unit: "LTR" } });
    const substitute = product({ perSalesUnit: { value: 0.1, unit: "LTR" } });
    const regression = planOriginalQuantity({ value: 4.4, unit: "CASE" }, original, {
      stock: "confirmed",
      amount: 4.3,
    });
    expect(regression.ok).toBe(true);
    if (!regression.ok || regression.value.shortfall === null)
      throw new Error("Expected shortfall");
    expect(quantityForShortfall(regression.value.shortfall, original, substitute)).toEqual({
      value: 1,
      unit: "CASE",
    });
    const fullRequest = { value: 0.9, unit: "CASE" };
    expect(
      planOriginalQuantity(fullRequest, product({ allowedLotSize: 0.3 }), {
        stock: "confirmed",
        amount: 0.9,
      }),
    ).toEqual({ ok: true, value: { quantity: fullRequest, shortfall: null } });

    const scale = 1000;
    for (const originalLotTicks of [100, 250, 500, 1000]) {
      for (const originalConversionTicks of [100, 250, 1000]) {
        for (const substituteLotTicks of [100, 500, 1000]) {
          for (const substituteConversionTicks of [100, 250, 1000]) {
            const source = product({
              allowedLotSize: originalLotTicks / scale,
              perSalesUnit: { value: originalConversionTicks / scale, unit: "LTR" },
            });
            const target = product({
              salesUnit: "PACK",
              allowedLotSize: substituteLotTicks / scale,
              perSalesUnit: { value: substituteConversionTicks / scale, unit: "LTR" },
            });
            for (const availableCount of [43, 999, 100000]) {
              const requested = {
                value: (availableCount * originalLotTicks) / scale,
                unit: "CASE",
              };
              for (const extraCount of [0, 1]) {
                expect(
                  planOriginalQuantity(requested, source, {
                    stock: "confirmed",
                    amount: ((availableCount + extraCount) * originalLotTicks) / scale,
                  }),
                ).toEqual({ ok: true, value: { quantity: requested, shortfall: null } });
              }
              for (const missingCount of [1, 2, 3]) {
                const plan = planOriginalQuantity(
                  {
                    value: ((availableCount + missingCount) * originalLotTicks) / scale,
                    unit: "CASE",
                  },
                  source,
                  { stock: "confirmed", amount: (availableCount * originalLotTicks) / scale },
                );
                expect(plan.ok).toBe(true);
                if (!plan.ok || plan.value.shortfall === null)
                  throw new Error("Expected shortfall");
                const standardTicks = missingCount * originalLotTicks * originalConversionTicks;
                const substituteLotStandardTicks = substituteLotTicks * substituteConversionTicks;
                const expectedCount = Math.ceil(standardTicks / substituteLotStandardTicks);
                const quantity = quantityForShortfall(plan.value.shortfall, source, target);
                expect(quantity?.unit).toBe("PACK");
                expect(quantity?.value).toBeCloseTo(
                  (expectedCount * substituteLotTicks) / scale,
                  10,
                );
              }
            }
          }
        }
      }
    }
    expect(
      planOriginalQuantity({ value: 100000.01, unit: "CASE" }, product(), {
        stock: "confirmed",
        amount: 99999,
      }),
    ).toEqual({ ok: false, error: "INVALID_QUANTITY" });
  });
});

describe("substitute ranking", () => {
  test("uses factual soft match before price, reliability, CO2 and deterministic id", () => {
    const original = quoted("original", 2);
    const candidates = [
      quoted("z", 2, { deliveryReliability: 0.8, co2PerKg: 1 }),
      quoted("b", 2, { deliveryReliability: 0.9, co2PerKg: 1 }),
      quoted("a", 2, { deliveryReliability: 0.9, co2PerKg: 1 }),
      quoted("low-co2", 2, { deliveryReliability: 0.9, co2PerKg: 0 }),
      quoted("cheap", 0, { countryOfOrigin: "se" }),
    ];
    expect(
      rankSubstitutes(original, candidates, [{ attribute: "countryOfOrigin", prefer: "FI" }]).map(
        (item) => [item.productId, item.rank],
      ),
    ).toEqual([
      ["low-co2", "best"],
      ["a", "better"],
      ["b", "good"],
    ]);
    expect(rankSubstitutes(original, candidates, []).map((item) => item.productId)).toEqual([
      "cheap",
      "low-co2",
      "a",
    ]);
  });
  test("ranks known category preferences before price while unsupported facts remain unknown", () => {
    const original = quoted("original", 2);
    const candidates = [
      quoted("cheap-a", 1, { category: "bread", countryOfOrigin: null }),
      quoted("cheap-b", 2, { category: "bread" }),
      quoted("cheap-c", 3, { category: "bread" }),
      quoted("category-match", 10, { category: "Dairy" }),
    ];
    expect(
      rankSubstitutes(original, candidates, [
        { attribute: "category", prefer: "dAiRy" },
        { attribute: "organic", prefer: "yes" },
      ]).map((item) => item.productId),
    ).toEqual(["category-match", "cheap-a", "cheap-b"]);
    expect(
      rankSubstitutes(original, candidates, [
        { attribute: "organic", prefer: "yes" },
        { attribute: "countryOfOrigin", prefer: "unknown" },
      ]).map((item) => item.productId),
    ).toEqual(["cheap-a", "cheap-b", "cheap-c"]);
  });
  test("zero is known, null sorts last, and deltas require comparable facts", () => {
    const original = quoted("original", 0, { deliveryReliability: 0, countryOfOrigin: null });
    const ranked = rankSubstitutes(
      original,
      [
        quoted("unknown", 0, { perSalesUnit: null, deliveryReliability: null, co2PerKg: null }),
        quoted("zero", 0, { deliveryReliability: 0, co2PerKg: 0 }),
        quoted("other", 2, { perSalesUnit: { value: 2, unit: "KGM" }, deliveryReliability: null }),
      ],
      [],
    );
    expect(ranked.map((item) => item.productId)).toEqual(["zero", "other", "unknown"]);
    expect(ranked[0]?.comparison).toEqual({
      replaces: "original",
      pricePerStdUnitDelta: 0,
      reliabilityDelta: 0,
      originDiffers: null,
    });
    expect(ranked[1]?.comparison.pricePerStdUnitDelta).toBeNull();
    expect(ranked[2]?.comparison.reliabilityDelta).toBeNull();
    expect(
      pricePerStdUnit({ net: 0, vatRate: 0, currency: "EUR" }, { value: 2, unit: "LTR" }),
    ).toEqual({ value: 0, unit: "LTR" });
    expect(pricePerStdUnit({ net: 1, vatRate: 0, currency: "EUR" }, null)).toBeNull();
  });
});
