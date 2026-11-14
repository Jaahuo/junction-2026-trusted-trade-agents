import type {
  AvailabilityQuote,
  OfferClaims,
  OfferLine,
  PriceQuote,
  ProductFacts,
  Quantity,
  SoftConstraint,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { checkQuantity, toCents } from "./offer-rules.ts";
import { lotCount, lotProduct } from "./lot-arithmetic.ts";

const safe = (value: number): boolean =>
  Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const positive = (value: number): boolean => safe(value) && value > 0;

export function stockCovers(available: number, required: number, lotSize: number): boolean {
  if (!safe(available) || available < 0 || !safe(required) || required < 0 || !positive(lotSize))
    return false;
  const availableCount = lotCount(available, [lotSize], "floor");
  const requiredCount = lotCount(required, [lotSize], "ceil");
  return availableCount !== null && requiredCount !== null && availableCount >= requiredCount;
}

export function floorToLot(amount: number, lotSize: number): number | null {
  if (!safe(amount) || amount < 0 || !positive(lotSize)) return null;
  const count = lotCount(amount, [lotSize], "floor");
  return count === null ? null : lotProduct(count, [lotSize]);
}

export function planOriginalQuantity(
  requested: Quantity,
  product: ProductFacts,
  stock: Pick<AvailabilityQuote, "stock" | "amount">,
): Result<
  { quantity: Quantity; shortfall: Quantity | null },
  "INVALID_QUANTITY" | "INSUFFICIENT_STOCK"
> {
  if (checkQuantity(requested, product) !== null || !safe(requested.value))
    return err("INVALID_QUANTITY");
  if (!positive(product.allowedLotSize)) return err("INVALID_QUANTITY");
  const requestedCount = lotCount(requested.value, [product.allowedLotSize], "whole");
  if (requestedCount === null || requestedCount < 1n) return err("INVALID_QUANTITY");
  if (stock.stock !== "confirmed") return ok({ quantity: requested, shortfall: null });
  if (!safe(stock.amount) || stock.amount < 0) return err("INVALID_QUANTITY");
  const availableCount = lotCount(stock.amount, [product.allowedLotSize], "floor");
  if (availableCount === null) return err("INVALID_QUANTITY");
  if (availableCount <= 0n) return err("INSUFFICIENT_STOCK");
  if (availableCount >= requestedCount) return ok({ quantity: requested, shortfall: null });
  const available = lotProduct(availableCount, [product.allowedLotSize]);
  if (available === null) return err("INVALID_QUANTITY");
  const conversion = product.perSalesUnit;
  if (
    conversion !== null &&
    (!positive(conversion.value) || (conversion.unit !== "LTR" && conversion.unit !== "KGM"))
  )
    return err("INVALID_QUANTITY");
  const value = lotProduct(requestedCount - availableCount, [
    product.allowedLotSize,
    conversion?.value ?? 1,
  ]);
  if (value === null || !positive(value)) return err("INVALID_QUANTITY");
  return ok({
    quantity: { value: available, unit: requested.unit },
    shortfall: { value, unit: conversion?.unit ?? requested.unit },
  });
}

export function quantityForShortfall(
  shortfall: Quantity,
  original: ProductFacts,
  substitute: ProductFacts,
): Quantity | null {
  if (!positive(shortfall.value) || !positive(substitute.allowedLotSize)) return null;
  let conversion = 1;
  if (original.perSalesUnit === null) {
    if (shortfall.unit !== original.salesUnit || substitute.salesUnit !== original.salesUnit)
      return null;
  } else {
    const source = original.perSalesUnit;
    const target = substitute.perSalesUnit;
    if (
      !positive(source.value) ||
      (source.unit !== "LTR" && source.unit !== "KGM") ||
      shortfall.unit !== source.unit ||
      target === null ||
      target.unit !== source.unit ||
      !positive(target.value)
    )
      return null;
    conversion = target.value;
  }
  const count = lotCount(shortfall.value, [conversion, substitute.allowedLotSize], "ceil");
  if (count === null) return null;
  const value = lotProduct(count, [substitute.allowedLotSize]);
  if (value === null || !positive(value)) return null;
  return { value, unit: substitute.salesUnit };
}

export function pricePerStdUnit(
  unitPrice: OfferClaims["unitPrice"],
  perSalesUnit: Quantity | null,
): { value: number; unit: "LTR" | "KGM" } | null {
  if (
    perSalesUnit === null ||
    !positive(perSalesUnit.value) ||
    (perSalesUnit.unit !== "LTR" && perSalesUnit.unit !== "KGM") ||
    !safe(unitPrice.net) ||
    unitPrice.net < 0
  )
    return null;
  const value = unitPrice.net / perSalesUnit.value;
  return safe(value) ? { value, unit: perSalesUnit.unit } : null;
}

/**
 * Gross price (VAT, no deposit) per litre or kilogram (SPEC-006): the wholesaler's comparison price
 * first, else the unit price over the sales unit's standard quantity, else null.
 */
export function grossPerStandardUnit(
  price: Pick<PriceQuote, "unitPrice" | "comparisonPrice">,
  perSalesUnit: Quantity | null,
): { gross: number; unit: "LTR" | "KGM" } | null {
  const net =
    price.comparisonPrice !== null &&
    safe(price.comparisonPrice.value) &&
    price.comparisonPrice.value >= 0
      ? price.comparisonPrice
      : pricePerStdUnit(price.unitPrice, perSalesUnit);
  if (net === null) return null;
  const gross = toCents(net.value * (1 + price.unitPrice.vatRate / 100));
  return safe(gross) ? { gross, unit: net.unit } : null;
}

export interface QuotedProduct {
  product: ProductFacts;
  price: PriceQuote;
}
export interface RankedSubstitute {
  productId: string;
  rank: NonNullable<OfferLine["rank"]>;
  comparison: NonNullable<OfferLine["comparison"]>;
}

function compareNullable(a: number | null, b: number | null, descending = false): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

function numeric(value: number | null): number | null {
  return value !== null && safe(value) ? value : null;
}

export function rankSubstitutes(
  original: QuotedProduct,
  candidates: readonly QuotedProduct[],
  soft: readonly SoftConstraint[],
): RankedSubstitute[] {
  const originalPrice = pricePerStdUnit(original.price.unitPrice, original.product.perSalesUnit);
  const scored = candidates.map(({ product, price }) => {
    const standardPrice = pricePerStdUnit(price.unitPrice, product.perSalesUnit);
    const softMatches = soft.filter(({ attribute, prefer }) => {
      const fact =
        attribute === "countryOfOrigin"
          ? product.countryOfOrigin
          : attribute === "category"
            ? product.category
            : null;
      return fact != null && fact.toLowerCase() === prefer.toLowerCase();
    }).length;
    const reliability = numeric(product.deliveryReliability);
    const originalReliability = numeric(original.product.deliveryReliability);
    const priceDelta =
      standardPrice !== null && originalPrice !== null && standardPrice.unit === originalPrice.unit
        ? numeric(standardPrice.value - originalPrice.value)
        : null;
    const reliabilityDelta =
      reliability !== null && originalReliability !== null
        ? numeric(reliability - originalReliability)
        : null;
    return {
      productId: product.productId,
      softMatches,
      price: standardPrice?.value ?? null,
      reliability,
      co2: numeric(product.co2PerKg),
      comparison: {
        replaces: original.product.productId,
        pricePerStdUnitDelta: priceDelta,
        reliabilityDelta,
        originDiffers:
          product.countryOfOrigin === null || original.product.countryOfOrigin === null
            ? null
            : product.countryOfOrigin.toLowerCase() !==
              original.product.countryOfOrigin.toLowerCase(),
      },
    };
  });
  scored.sort(
    (a, b) =>
      b.softMatches - a.softMatches ||
      compareNullable(a.price, b.price) ||
      compareNullable(a.reliability, b.reliability, true) ||
      compareNullable(a.co2, b.co2) ||
      (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
  );
  const ranks = ["best", "better", "good"] as const;
  return scored.slice(0, 3).map((item, index) => ({
    productId: item.productId,
    rank: ranks[index] ?? "good",
    comparison: item.comparison,
  }));
}
