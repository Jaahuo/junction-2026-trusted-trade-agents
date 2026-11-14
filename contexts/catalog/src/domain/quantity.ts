import type { Quantity } from "@app/contract";

const STD_UNITS = new Map<string, { unit: "LTR" | "KGM"; factor: number }>([
  ["LTR", { unit: "LTR", factor: 1 }],
  ["CLT", { unit: "LTR", factor: 0.01 }],
  ["MLT", { unit: "LTR", factor: 0.001 }],
  ["KGM", { unit: "KGM", factor: 1 }],
  ["GRM", { unit: "KGM", factor: 0.001 }],
]);

// Remove only floating-point noise, without rounding away meaningful precision.
const tidy = (value: number): number => {
  const rounded = Number(value.toPrecision(15));
  return Math.abs(value - rounded) <= Number.EPSILON * Math.abs(value) * 2 ? rounded : value;
};

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
  const noise = Math.abs(lots - nearest) <= Number.EPSILON * Math.max(1, Math.abs(lots)) * 2;
  return Math.max(1, noise ? nearest : Math.ceil(lots));
};

const COUNT_UNITS: Record<string, true> = {
  BAG: true,
  BOT: true,
  CS: true,
  DSP: true,
  DZ: true,
  KAN: true,
  KI: true,
  KLE: true,
  KRT: true,
  NIP: true,
  PAK: true,
  PAL: true,
  PRK: true,
  RAS: true,
  SK: true,
  ST: true,
  H87: true,
  PCE: true,
  EA: true,
  PK: true,
};

// For a decimal lot p/q in lowest terms, the smallest whole compatible count is p.
const wholeLotStep = (lot: number): number | null => {
  const [mantissa = "", exponentText] = lot.toString().split("e");
  const [integer = "", fraction = ""] = mantissa.split(".");
  const exponent = Number(exponentText ?? 0) - fraction.length;
  let numerator = BigInt(integer + fraction);
  let denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  const step = Number(numerator / a);
  return Number.isSafeInteger(step) && step > 0 ? step : null;
};

/** Consumer-unit volume times consumer units per sales unit, in a std unit. */
export const perSalesUnit = (
  consumerUnitVolume: Quantity | null,
  unitsPerSalesUnit: number,
): Quantity | null => {
  if (consumerUnitVolume === null) return null;
  const std = toStdQuantity(consumerUnitVolume);
  if (
    std === null ||
    !Number.isFinite(std.value) ||
    std.value <= 0 ||
    !Number.isFinite(unitsPerSalesUnit) ||
    unitsPerSalesUnit <= 0
  )
    return null;
  const value = tidy(std.value * unitsPerSalesUnit);
  return Number.isFinite(value) && value > 0 ? { value, unit: std.unit } : null;
};

export interface SalesUnitInfo {
  salesUnit: string;
  allowedLotSize: number;
  perSalesUnit: Quantity | null;
}

export interface OrderQuantity {
  orderQuantity: Quantity | null;
  equals: Quantity | null;
  quantityReason?: string;
}

const unavailable = (quantityReason: string): OrderQuantity => ({
  orderQuantity: null,
  equals: null,
  quantityReason,
});

/** Converts a requested quantity to sales units, rounded up to a multiple of `allowedLotSize`. */
export const toOrderQuantity = (requested: Quantity, product: SalesUnitInfo): OrderQuantity => {
  const per = product.perSalesUnit;
  if (per === null) return unavailable("Sales unit conversion is unavailable.");
  if (
    !Number.isFinite(requested.value) ||
    requested.value <= 0 ||
    !Number.isFinite(per.value) ||
    per.value <= 0 ||
    !Number.isFinite(product.allowedLotSize) ||
    product.allowedLotSize <= 0
  )
    return unavailable("Quantity or conversion data is invalid.");
  let salesUnits: number;
  if (requested.unit === product.salesUnit) {
    salesUnits = requested.value;
  } else {
    const std = toStdQuantity(requested);
    if (std === null || std.unit !== per.unit)
      return unavailable("Requested unit is incompatible with the sales unit.");
    salesUnits = std.value / per.value;
  }
  const count = Object.hasOwn(COUNT_UNITS, product.salesUnit);
  if (!count && product.salesUnit !== "KG" && product.salesUnit !== "KGM")
    return unavailable("Sales unit is not supported.");
  const step = count ? wholeLotStep(product.allowedLotSize) : product.allowedLotSize;
  if (step === null || !Number.isFinite(salesUnits) || salesUnits <= 0)
    return unavailable("Quantity conversion exceeds supported precision.");
  const value = tidy(ceilLots(salesUnits / step) * step);
  const equals = tidy(value * per.value);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(equals) ||
    equals <= 0 ||
    (count && !Number.isSafeInteger(value))
  )
    return unavailable("Quantity conversion exceeds supported precision.");
  return {
    orderQuantity: { value, unit: product.salesUnit },
    equals: { value: equals, unit: per.unit },
  };
};
