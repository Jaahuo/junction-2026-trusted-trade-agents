import type {
  AvailabilityQuote,
  HardConstraint,
  MatchState,
  Quantity,
  SoftConstraint,
} from "@app/contract";
import { shiftHelsinkiDays } from "./helsinki-time.ts";

export interface Constraints {
  hard: HardConstraint[];
  soft: SoftConstraint[];
}

export const toCents = (value: number): number =>
  Math.round(Number((value * 100).toPrecision(12))) / 100;

export function lineTotal(
  unitPrice: { net: number; vatRate: number },
  deposit: number,
  quantity: number,
): { total: { net: number; gross: number }; deposits: number } {
  const gross = (unitPrice.net * (1 + unitPrice.vatRate / 100) + deposit) * quantity;
  return {
    total: { net: toCents(unitPrice.net * quantity), gross: toCents(gross) },
    deposits: toCents(deposit * quantity),
  };
}

export function offerExpiry(validTo: string, cutoffAt: string | null): Date {
  const end = new Date(validTo);
  if (cutoffAt === null) return end;
  const cutoff = new Date(cutoffAt);
  return cutoff < end ? cutoff : end;
}

/** How long a price may be served from the cache, at most (SPEC-005). */
const PRICE_CACHE_MS = 5 * 60_000;

/** The earliest of validTo, cutoffAt and PRICE_CACHE_MS after the lookup. */
export function priceCacheExpiry(validTo: string, cutoffAt: string | null, lookedUpAt: Date): Date {
  const bound = offerExpiry(validTo, cutoffAt);
  const capped = new Date(lookedUpAt.getTime() + PRICE_CACHE_MS);
  return capped < bound ? capped : bound;
}

export function expiredOmitReason(
  validTo: string,
  cutoffAt: string | null,
  now: Date,
): "NO_DELIVERY_DATE" | "NO_PRICE" | null {
  if (cutoffAt !== null && new Date(cutoffAt) <= now) return "NO_DELIVERY_DATE";
  if (new Date(validTo) <= now) return "NO_PRICE";
  return null;
}

const LOT_TOLERANCE = 1e-12;

export function checkQuantity(
  quantity: Quantity,
  facts: { salesUnit: string; allowedLotSize: number },
): "INVALID_QUANTITY" | null {
  const { value, unit } = quantity;
  if (unit !== facts.salesUnit || !Number.isFinite(value) || value <= 0) return "INVALID_QUANTITY";
  if (!Number.isFinite(facts.allowedLotSize) || facts.allowedLotSize <= 0)
    return "INVALID_QUANTITY";
  const lots = value / facts.allowedLotSize;
  const whole = Math.round(lots);
  return whole >= 1 &&
    Number.isSafeInteger(whole) &&
    Math.abs(lots - whole) <= LOT_TOLERANCE * Math.max(1, whole)
    ? null
    : "INVALID_QUANTITY";
}

function unionBy<T>(first: readonly T[], second: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...first, ...second]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function mergeConstraints(request: Constraints, standing: Constraints | null): Constraints {
  if (standing === null)
    return { hard: unionBy(request.hard, []), soft: unionBy(request.soft, []) };
  return {
    hard: unionBy(request.hard, standing.hard),
    soft: unionBy(request.soft, standing.soft),
  };
}

export function contradictedAttribute(
  match: Readonly<Record<string, MatchState>>,
  hard: readonly HardConstraint[],
): string | null {
  for (const constraint of hard) {
    if (match[constraint.attribute] === "contradicted") return constraint.attribute;
  }
  return null;
}

export function availabilityOmitReason(
  availability: AvailabilityQuote | undefined,
  requested: number,
): "SALES_BLOCKED" | "NO_DELIVERY_DATE" | "INSUFFICIENT_STOCK" | null {
  if (availability === undefined) return "NO_DELIVERY_DATE";
  if (availability.salesBlocked) return "SALES_BLOCKED";
  if (availability.availableDate === null) return "NO_DELIVERY_DATE";
  if (availability.stock === "confirmed" && availability.amount < requested) {
    return "INSUFFICIENT_STOCK";
  }
  return null;
}

/** Advance an earlier available slot to the requested date without asserting future stock. */
export function deliveryOnRequestedDate(
  quote: AvailabilityQuote,
  requestedDate: string,
): AvailabilityQuote {
  if (quote.availableDate === null || quote.availableDate >= requestedDate) return quote;
  const days =
    (Date.parse(`${requestedDate}T00:00:00Z`) - Date.parse(`${quote.availableDate}T00:00:00Z`)) /
    86_400_000;
  return {
    ...quote,
    availableDate: requestedDate,
    nextDeliveryDate:
      quote.nextDeliveryDate !== null && quote.nextDeliveryDate > requestedDate
        ? quote.nextDeliveryDate
        : null,
    cutoffAt: quote.cutoffAt === null ? null : shiftHelsinkiDays(quote.cutoffAt, days),
    stock: "unconfirmed",
  };
}

/**
 * True when the product can arrive on or before the requested date and its order cut-off has not
 * passed. Stock is not checked: a product with partial stock still gets an offer with a shortfall.
 */
export function isDeliverableBy(
  availability: AvailabilityQuote | undefined,
  deliverBy: string,
  now: Date,
): boolean {
  if (availability === undefined || availabilityOmitReason(availability, 0) !== null) return false;
  const dated = deliveryOnRequestedDate(availability, deliverBy);
  if (dated.cutoffAt !== null && new Date(dated.cutoffAt) <= now) return false;
  return dated.availableDate !== null && dated.availableDate <= deliverBy;
}

export function batchIds(ids: readonly string[], max = 1000): string[][] {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += max) batches.push(unique.slice(i, i + max));
  return batches;
}
