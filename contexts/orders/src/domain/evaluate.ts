import {
  ALLERGEN_ATTRIBUTES,
  type Evaluate,
  type Evaluation,
  GUARDRAILS,
  type MandateLimits,
  type OfferClaims,
  type Quantity,
  type ReasonCode,
  REJECT_REASONS,
  type SubstitutionRule,
  samePair,
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

const quantityEvidence = (product: ProductSum, rows: HistoryRow[]): string | null => {
  const values = rows.flatMap((row) => {
    const value = inSalesUnits(row.quantity, product);
    return value === null ? [] : [value];
  });
  const usual = median(values);
  if (usual !== null) {
    const limit = GUARDRAILS.quantityCapFactor * usual;
    return product.sales > limit
      ? `Summed quantity ${Number.isFinite(product.sales) ? product.sales : "unknown (incompatible units)"} ${product.salesUnit}; median of ${values.length} convertible history rows ${usual} ${product.salesUnit}, limit ${limit} ${product.salesUnit} (${GUARDRAILS.quantityCapFactor} times median).`
      : null;
  }
  return product.std === null || product.std > GUARDRAILS.quantityCapNoHistory
    ? `Summed quantity ${product.std ?? "unknown (conversion unavailable)"} standard units; no convertible history (${rows.length} rows), fallback limit ${GUARDRAILS.quantityCapNoHistory} standard units.`
    : null;
};

const isAllergenAttribute = (attribute: string): boolean =>
  ALLERGEN_ATTRIBUTES.some((allergen) => allergen === attribute);

/** The human's rule for a substitute line, while substitutions is ask. */
export const ruleFor = (
  limits: MandateLimits,
  claim: OfferClaims,
): SubstitutionRule | undefined => {
  const { replaces } = claim;
  if (replaces === null || limits.substitutions !== "ask") return undefined;
  return (limits.substitutionRules ?? []).find((rule) =>
    samePair(rule, { replaces, productId: claim.productId }),
  );
};

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

interface CheckEvidence {
  reason: ReasonCode;
  rule: string;
  detail: string;
  productId?: string;
}

export interface EvaluatedChecks {
  evaluation: Evaluation;
  evidence: CheckEvidence[];
}

const isReject = (reason: ReasonCode): boolean =>
  REJECT_REASONS.some((rejectReason) => rejectReason === reason);
/** Steps 1-5 of SPEC-009, with the evidence produced by each check. */
export const evaluateWithEvidence = ({
  claims,
  mandate,
  history,
  live,
  now,
}: Parameters<Evaluate>[0]): EvaluatedChecks => {
  const evidence: CheckEvidence[] = [];
  const add = (reason: ReasonCode, rule: string, detail: string, productId?: string) =>
    evidence.push({ reason, rule, detail, ...(productId === undefined ? {} : { productId }) });
  if (mandate === null)
    add("MANDATE_INVALID", "Current mandate", "No current mandate is available.");
  for (const claim of claims) {
    if (cutoffPassed(claim, now))
      add(
        "CUTOFF_PASSED",
        "Delivery cutoff",
        `Product ${claim.product.name} (${claim.productId}): cutoff ${claim.cutoffAt}; checked at ${now.toISOString()}.`,
      );
    else if (claim.exp <= Math.floor(now.getTime() / 1000))
      add(
        "OFFER_EXPIRED",
        "Offer expiry",
        `Product ${claim.product.name} (${claim.productId}): expiry ${new Date(claim.exp * 1000).toISOString()}; checked at ${now.toISOString()}.`,
      );
  }
  for (const result of live?.results ?? []) {
    if (!result.ok) {
      const reason = result.reason === "SALES_BLOCKED" ? "SALES_BLOCKED" : "CUTOFF_PASSED";
      const claim = claims.find((entry) => entry.offerId === result.offerId);
      add(
        reason,
        "Live offer validation",
        `${claim === undefined ? "Unknown product" : `Product ${claim.product.name} (${claim.productId})`}, offer ${result.offerId}: ${result.reason}; next delivery ${result.nextDeliveryDate ?? "unknown"}.`,
      );
    }
  }
  const historyOf = (productId: string) => history.filter((row) => row.productId === productId);
  for (const [productId, product] of sumByProduct(claims)) {
    const quantity = quantityEvidence(product, historyOf(productId));
    if (quantity !== null)
      add(
        "QUANTITY_UNUSUAL",
        "Quantity guardrail",
        `Product ${product.claims[0]?.product.name ?? productId} (${productId}): ${quantity}`,
      );
    if (
      product.claims.some((claim) => claim.stock === "unconfirmed") &&
      (product.std === null || product.std > GUARDRAILS.unconfirmedStockMax)
    )
      add(
        "UNCONFIRMED_STOCK",
        "Unconfirmed stock cap",
        `Product ${product.claims[0]?.product.name ?? productId} (${productId}): summed quantity ${product.std ?? "unknown (conversion unavailable)"} standard units; stock unconfirmed, limit ${GUARDRAILS.unconfirmedStockMax} standard units.`,
      );
  }
  if (mandate !== null) {
    const { limits } = mandate;
    const total = grossTotal(claims);
    if (total > limits.maxOrderTotal.value)
      add(
        "SPEND_OVER_LIMIT",
        "Maximum order total",
        `Gross spend ${total} EUR; limit ${limits.maxOrderTotal.value} EUR.`,
      );
    for (const claim of claims) {
      const id = claim.productId;
      if (limits.categories !== null && !limits.categories.includes(claim.product.category))
        add(
          "CATEGORY_NOT_ALLOWED",
          "Allowed categories",
          `Category ${claim.product.category}; allowed categories ${limits.categories.join(", ") || "none"}.`,
          id,
        );
      if (
        claim.replaces !== null &&
        limits.substitutions !== "auto" &&
        ruleFor(limits, claim)?.policy !== "auto"
      )
        add(
          "SUBSTITUTION",
          "Substitution policy",
          `Replaces ${claim.replaces}; policy ${limits.substitutions}, pair policy ${ruleFor(limits, claim)?.policy ?? "none"}.`,
          id,
        );
      const count = historyOf(id).length;
      if (count === 0 && limits.newProducts === "ask")
        add(
          "NEW_PRODUCT",
          "New product policy",
          `History count ${count}; policy ${limits.newProducts}.`,
          id,
        );
      const threshold = (
        value: number | null,
        limit: { value: number; ifNoData: "auto" | "ask" } | null,
        label: string,
        reason: ReasonCode,
        breaks: (a: number, b: number) => boolean,
      ) => {
        if (limit === null) return;
        if (value === null && limit.ifNoData === "ask")
          add(
            "UNCONFIRMED_DATA",
            label,
            `${label} unknown; limit ${limit.value}, missing-data policy ${limit.ifNoData}.`,
            id,
          );
        else if (value !== null && breaks(value, limit.value))
          add(
            reason,
            label,
            `${label} ${value}; limit ${limit.value}, missing-data policy ${limit.ifNoData}.`,
            id,
          );
      };
      threshold(
        claim.product.deliveryReliability,
        limits.minDeliveryReliability,
        "Minimum delivery reliability",
        "RELIABILITY_BELOW_MIN",
        (a, b) => a < b,
      );
      threshold(
        claim.product.co2PerKg,
        limits.maxCo2PerKg,
        "Maximum CO2 per kg",
        "CO2_ABOVE_MAX",
        (a, b) => a > b,
      );
      for (const { attribute } of claim.constraints.hard) {
        const match = claim.product.match[attribute];
        if (
          match === "confirmed" ||
          (match === "unknown" &&
            isAllergenAttribute(attribute) &&
            limits.allergenData.ifNoData === "auto")
        )
          continue;
        add(
          "UNCONFIRMED_ALLERGEN",
          "Hard constraint",
          `Hard constraint ${attribute}; match ${match ?? "missing"}, allergen missing-data policy ${limits.allergenData.ifNoData}.`,
          id,
        );
      }
      if (limits.paymentTerms[claim.paymentTerms] === "ask")
        add(
          "PAYMENT_TERMS",
          "Payment terms policy",
          `Payment terms ${claim.paymentTerms}; policy ${limits.paymentTerms[claim.paymentTerms]}.`,
        );
      if (claim.deliveryDate > claim.requestedDate || claim.shortfall !== null)
        add(
          "AVAILABILITY_DIFFERS",
          "Requested availability",
          `Requested date ${claim.requestedDate}; delivery date ${claim.deliveryDate}; shortfall ${claim.shortfall === null ? "none" : JSON.stringify(claim.shortfall)}.`,
          id,
        );
    }
  }
  const reasons = [...new Set(evidence.map((item) => item.reason))];
  const decision = reasons.some(isReject)
    ? "rejected"
    : reasons.length > 0
      ? "needs_approval"
      : "auto";
  return { evaluation: { decision, reasons }, evidence };
};

export const evaluate: Evaluate = (input) => evaluateWithEvidence(input).evaluation;
