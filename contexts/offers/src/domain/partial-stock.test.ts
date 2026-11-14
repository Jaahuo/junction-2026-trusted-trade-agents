import { describe, expect, test } from "bun:test";
import type { ProductFacts } from "@app/contract";
import {
  floorToLot,
  planOriginalQuantity,
  pricePerStdUnit,
  quantityForShortfall,
  rankSubstitutes,
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
