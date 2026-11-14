import {
  ALLERGEN_ATTRIBUTES,
  type Evaluate,
  type Evaluation,
  GUARDRAILS,
  type Mandate,
  type OfferClaims,
  type Quantity,
  type ReasonCode,
  REJECT_REASONS,
  type ValidateResult,
} from "@app/contract";

export interface HistoryRow {
  productId: string;
  quantity: Quantity;
}

/** The lines of one product, summed: every quantity rule applies to the sum (SPEC-009). */
interface ProductSum {
  claims: OfferClaims[];
  /** Sales units. */
  sales: number;
  salesUnit: string;
  perSalesUnit: Quantity | null;
  /** Std units; null when a line has no conversion. */
  std: number | null;
}

/** Std units of one line; null when its unit size is missing or not a positive number. */
const lineStdOf = (claim: OfferClaims): number | null => {
  const per = claim.product.perSalesUnit;
  return per !== null && Number.isFinite(per.value) && per.value > 0
    ? claim.quantity.value * per.value
    : null;
};

const sumByProduct = (claims: OfferClaims[]): Map<string, ProductSum> => {
  const products = new Map<string, ProductSum>();
  for (const claim of claims) {
    const lineStd = lineStdOf(claim);
    const known = products.get(claim.productId);
    if (known === undefined) {
      products.set(claim.productId, {
        claims: [claim],
        sales: claim.quantity.value,
        salesUnit: claim.quantity.unit,
        perSalesUnit: claim.product.perSalesUnit,
        std: lineStd,
      });
      continue;
    }
    known.claims.push(claim);
    if (claim.quantity.unit === known.salesUnit) {
      known.sales += claim.quantity.value;
      known.std = known.std === null || lineStd === null ? null : known.std + lineStd;
    } else {
      // Lines in different units cannot be summed, so the product counts as over every quantity cap.
      known.sales = Number.POSITIVE_INFINITY;
      known.std = null;
    }
  }
  return products;
};

/** A history row in the product's sales units; null when its unit cannot be converted. */
const inSalesUnits = (row: Quantity, product: ProductSum): number | null => {
  if (row.unit === product.salesUnit) return row.value;
  const per = product.perSalesUnit;
  return per !== null && per.value > 0 && row.unit === per.unit ? row.value / per.value : null;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
};

const isQuantityUnusual = (product: ProductSum, rows: HistoryRow[]): boolean => {
  const usual = median(
    rows.flatMap((row) => {
      const value = inSalesUnits(row.quantity, product);
      return value === null ? [] : [value];
    }),
  );
  if (usual !== null) return product.sales > GUARDRAILS.quantityCapFactor * usual;
  return product.std === null || product.std > GUARDRAILS.quantityCapNoHistory;
};

const isUnconfirmedStockOverCap = (product: ProductSum): boolean =>
  product.claims.some((claim) => claim.stock === "unconfirmed") &&
  (product.std === null || product.std > GUARDRAILS.unconfirmedStockMax);

const isAllergenAttribute = (attribute: string): boolean =>
  ALLERGEN_ATTRIBUTES.some((allergen) => allergen === attribute);

/**
 * True when a hard constraint of the line is not confirmed in a way the mandate accepts:
 * contradicted or missing always, unknown unless allergen data is set to auto.
 */
const hasUnconfirmedHardConstraint = (claim: OfferClaims, mandate: Mandate): boolean =>
  claim.constraints.hard.some(({ attribute }) => {
    const match = claim.product.match[attribute];
    if (match === "confirmed") return false;
    if (match === "unknown")
      return !isAllergenAttribute(attribute) || mandate.limits.allergenData.ifNoData === "ask";
    return true;
  });

const thresholdReasons = (
  value: number | null,
  limit: { value: number; ifNoData: "auto" | "ask" } | null,
  breaks: (value: number, limit: number) => boolean,
  reason: ReasonCode,
): ReasonCode[] => {
  if (limit === null) return [];
  if (value === null) return limit.ifNoData === "ask" ? ["UNCONFIRMED_DATA"] : [];
  return breaks(value, limit.value) ? [reason] : [];
};

const buyerLimitReasons = (
  claim: OfferClaims,
  mandate: Mandate,
  historyOf: (productId: string) => HistoryRow[],
): ReasonCode[] => {
  const { limits } = mandate;
  const reasons: ReasonCode[] = [];
  if (limits.categories !== null && !limits.categories.includes(claim.product.category))
    reasons.push("CATEGORY_NOT_ALLOWED");
  if (claim.replaces !== null && limits.substitutions !== "auto") reasons.push("SUBSTITUTION");
  if (historyOf(claim.productId).length === 0 && limits.newProducts === "ask")
    reasons.push("NEW_PRODUCT");
  reasons.push(
    ...thresholdReasons(
      claim.product.deliveryReliability,
      limits.minDeliveryReliability,
      (value, min) => value < min,
      "RELIABILITY_BELOW_MIN",
    ),
    ...thresholdReasons(
      claim.product.co2PerKg,
      limits.maxCo2PerKg,
      (value, max) => value > max,
      "CO2_ABOVE_MAX",
    ),
  );
  if (hasUnconfirmedHardConstraint(claim, mandate)) reasons.push("UNCONFIRMED_ALLERGEN");
  if (limits.paymentTerms[claim.paymentTerms] === "ask") reasons.push("PAYMENT_TERMS");
  if (claim.deliveryDate > claim.requestedDate || claim.shortfall !== null)
    reasons.push("AVAILABILITY_DIFFERS");
  return reasons;
};

const liveReasons = (live: ValidateResult | null): ReasonCode[] =>
  (live?.results ?? []).flatMap((result) => {
    if (result.ok) return [];
    return [result.reason === "SALES_BLOCKED" ? "SALES_BLOCKED" : "CUTOFF_PASSED"];
  });

const cutoffPassed = (claim: OfferClaims, now: Date): boolean =>
  claim.cutoffAt !== null && Date.parse(claim.cutoffAt) <= now.getTime();

/** The gross total of the lines, rounded to cents. */
export const grossTotal = (claims: OfferClaims[]): number =>
  Math.round(claims.reduce((sum, claim) => sum + claim.total.gross, 0) * 100) / 100;

export const netTotal = (claims: OfferClaims[]): number =>
  Math.round(claims.reduce((sum, claim) => sum + claim.total.net, 0) * 100) / 100;

/** The earliest next delivery date among lines whose cut-off has passed. */
export const nextDeliveryDateAfterCutoff = (claims: OfferClaims[], now: Date): string | null =>
  claims
    .filter((claim) => cutoffPassed(claim, now))
    .flatMap((claim) => (claim.nextDeliveryDate === null ? [] : [claim.nextDeliveryDate]))
    .toSorted()[0] ?? null;

/** Reasons about the order as a whole, even when a line raises them. */
const ORDER_LEVEL: ReadonlySet<ReasonCode> = new Set(["PAYMENT_TERMS"]);

/**
 * The buyer-limit reasons each product raises, so the audit can name the product a check
 * failed for (a new product, CO₂ above the maximum …). Order-level reasons are left out.
 */
export const reasonsByProduct = (
  claims: OfferClaims[],
  mandate: Mandate | null,
  history: HistoryRow[],
): Map<string, ReasonCode[]> => {
  const byProduct = new Map<string, ReasonCode[]>();
  if (mandate === null) return byProduct;
  const historyOf = (productId: string) => history.filter((row) => row.productId === productId);
  for (const claim of claims) {
    const reasons = buyerLimitReasons(claim, mandate, historyOf).filter(
      (reason) => !ORDER_LEVEL.has(reason),
    );
    byProduct.set(claim.productId, [...(byProduct.get(claim.productId) ?? []), ...reasons]);
  }
  return byProduct;
};

const isReject = (reason: ReasonCode): boolean =>
  REJECT_REASONS.some((rejectReason) => rejectReason === reason);

/** Steps 1-5 of SPEC-009. Pure: no I/O, no writes. */
export const evaluate: Evaluate = ({ claims, mandate, history, live, now }): Evaluation => {
  const reasons: ReasonCode[] = [];
  if (mandate === null) reasons.push("MANDATE_INVALID");

  for (const claim of claims) {
    if (cutoffPassed(claim, now)) reasons.push("CUTOFF_PASSED");
    else if (claim.exp <= Math.floor(now.getTime() / 1000)) reasons.push("OFFER_EXPIRED");
  }

  reasons.push(...liveReasons(live));
  const historyOf = (productId: string) => history.filter((row) => row.productId === productId);
  const products = sumByProduct(claims);
  for (const [productId, product] of products) {
    if (isQuantityUnusual(product, historyOf(productId))) reasons.push("QUANTITY_UNUSUAL");
  }
  for (const product of products.values()) {
    if (isUnconfirmedStockOverCap(product)) reasons.push("UNCONFIRMED_STOCK");
  }

  if (mandate !== null) {
    if (grossTotal(claims) > mandate.limits.maxOrderTotal.value) reasons.push("SPEND_OVER_LIMIT");
    for (const claim of claims) reasons.push(...buyerLimitReasons(claim, mandate, historyOf));
  }

  const unique = [...new Set(reasons)];
  const decision = unique.some(isReject)
    ? "rejected"
    : unique.length > 0
      ? "needs_approval"
      : "auto";
  return { decision, reasons: unique };
};
