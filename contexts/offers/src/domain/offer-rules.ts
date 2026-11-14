import type {
  AvailabilityQuote,
  HardConstraint,
  MatchState,
  Quantity,
  SoftConstraint,
} from "@app/contract";

export interface Constraints {
  hard: HardConstraint[];
  soft: SoftConstraint[];
}

const toCents = (value: number): number => Math.round(Number((value * 100).toPrecision(12))) / 100;

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

export function expiredOmitReason(
  validTo: string,
  cutoffAt: string | null,
  now: Date,
): "NO_DELIVERY_DATE" | "NO_PRICE" | null {
  if (cutoffAt !== null && new Date(cutoffAt) <= now) return "NO_DELIVERY_DATE";
  if (new Date(validTo) <= now) return "NO_PRICE";
  return null;
}

const LOT_TOLERANCE = 1e-9;

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
  return whole >= 1 && Math.abs(lots - whole) <= LOT_TOLERANCE ? null : "INVALID_QUANTITY";
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

export function batchIds(ids: readonly string[], max = 1000): string[][] {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += max) batches.push(unique.slice(i, i + max));
  return batches;
}
