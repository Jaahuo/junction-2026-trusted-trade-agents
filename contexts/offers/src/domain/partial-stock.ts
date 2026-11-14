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
import { checkQuantity } from "./offer-rules.ts";

const TOLERANCE = 1e-12;
const safe = (value: number): boolean =>
  Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const positive = (value: number): boolean => safe(value) && value > 0;

export function floorToLot(amount: number, lotSize: number): number | null {
  if (!safe(amount) || amount < 0 || !positive(lotSize)) return null;
  const lots = amount / lotSize;
  if (!safe(lots)) return null;
  const nearest = Math.round(lots);
  const count =
    Math.abs(lots - nearest) <= TOLERANCE * Math.max(1, nearest) ? nearest : Math.floor(lots);
  if (!Number.isSafeInteger(count)) return null;
  const result = count * lotSize;
  return safe(result) ? result : null;
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
  if (stock.stock !== "confirmed") return ok({ quantity: requested, shortfall: null });
  const available = floorToLot(stock.amount, product.allowedLotSize);
  if (available === null) return err("INVALID_QUANTITY");
  if (available <= 0) return err("INSUFFICIENT_STOCK");
  if (available >= requested.value) return ok({ quantity: requested, shortfall: null });
  const missing = requested.value - available;
  const conversion = product.perSalesUnit;
  if (
    conversion !== null &&
    (!positive(conversion.value) || (conversion.unit !== "LTR" && conversion.unit !== "KGM"))
  )
    return err("INVALID_QUANTITY");
  const value = missing * (conversion?.value ?? 1);
  if (!positive(value)) return err("INVALID_QUANTITY");
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
  let units: number;
  if (original.perSalesUnit === null) {
    if (shortfall.unit !== original.salesUnit || substitute.salesUnit !== original.salesUnit)
      return null;
    units = shortfall.value;
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
    units = shortfall.value / target.value;
  }
  const lots = units / substitute.allowedLotSize;
  if (!positive(units) || !positive(lots)) return null;
  const nearest = Math.round(lots);
  const tolerance = Math.min(1e-9, 4 * Number.EPSILON * Math.max(1, lots));
  const count = nearest > 0 && Math.abs(lots - nearest) <= tolerance ? nearest : Math.ceil(lots);
  if (!Number.isSafeInteger(count)) return null;
  const value = count * substitute.allowedLotSize;
  if (!positive(value) || lots - count > tolerance) return null;
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
