import type { Quantity } from "@app/contract";

const STD_UNITS = new Map<string, { unit: "LTR" | "KGM"; factor: number }>([
  ["LTR", { unit: "LTR", factor: 1 }],
  ["CLT", { unit: "LTR", factor: 0.01 }],
  ["MLT", { unit: "LTR", factor: 0.001 }],
  ["KGM", { unit: "KGM", factor: 1 }],
  ["GRM", { unit: "KGM", factor: 0.001 }],
]);

// Removes binary noise such as 0.1 * 3 = 0.30000000000000004, without scaling that could overflow.
const tidy = (value: number): number => Number(value.toPrecision(12));

/** The quantity in a std unit (`LTR` or `KGM`), unrounded, or null when the unit has no std conversion. */
const toStdQuantity = (quantity: Quantity): Quantity | null => {
  const std = STD_UNITS.get(quantity.unit);
  return std === undefined ? null : { value: quantity.value * std.factor, unit: std.unit };
};

/** The largest quantity value a search accepts; far above any real order, far below float overflow. */
export const MAX_QUANTITY = 1e9;

/** A search quantity must be above 0 and at most `MAX_QUANTITY`. */
export const isValidQuantity = (quantity: Quantity): boolean =>
  Number.isFinite(quantity.value) && quantity.value > 0 && quantity.value <= MAX_QUANTITY;

// Ceil that ignores float noise only: 100.00000000000001 lots is 100, 100.000000004 is 101.
const ceilLots = (lots: number): number => {
  const nearest = Math.round(lots);
  const noise = Math.abs(lots - nearest) <= 1e-12 * Math.max(1, Math.abs(lots));
  return Math.max(1, noise ? nearest : Math.ceil(lots));
};

/** Consumer-unit volume times consumer units per sales unit, in a std unit. */
export const perSalesUnit = (
  consumerUnitVolume: Quantity | null,
  unitsPerSalesUnit: number,
): Quantity | null => {
  if (consumerUnitVolume === null) return null;
  const std = toStdQuantity(consumerUnitVolume);
  if (std === null || std.value <= 0 || unitsPerSalesUnit <= 0) return null;
  return { value: tidy(std.value * unitsPerSalesUnit), unit: std.unit };
};

export interface SalesUnitInfo {
  salesUnit: string;
  allowedLotSize: number;
  perSalesUnit: Quantity | null;
}

export interface OrderQuantity {
  orderQuantity: Quantity | null;
  equals: Quantity | null;
}

/** Converts a requested quantity to sales units, rounded up to a multiple of `allowedLotSize`. */
export const toOrderQuantity = (requested: Quantity, product: SalesUnitInfo): OrderQuantity => {
  const per = product.perSalesUnit;
  if (per === null) return { orderQuantity: null, equals: null };
  let salesUnits: number;
  if (requested.unit === product.salesUnit) {
    salesUnits = requested.value;
  } else {
    const std = toStdQuantity(requested);
    if (std === null || std.unit !== per.unit) return { orderQuantity: null, equals: null };
    salesUnits = std.value / per.value;
  }
  const lot = product.allowedLotSize > 0 ? product.allowedLotSize : 1;
  const value = tidy(ceilLots(salesUnits / lot) * lot);
  const equals = tidy(value * per.value);
  if (!Number.isFinite(value) || !Number.isFinite(equals))
    return { orderQuantity: null, equals: null };
  return {
    orderQuantity: { value, unit: product.salesUnit },
    equals: { value: equals, unit: per.unit },
  };
};
