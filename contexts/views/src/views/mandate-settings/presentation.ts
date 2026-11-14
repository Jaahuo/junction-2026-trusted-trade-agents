import type { MandateLimits, StoredMandate } from "@app/contract";

export function effectiveStatus(record: StoredMandate, now = Date.now()) {
  if (record.status === "revoked") return "revoked";
  return record.mandate.exp * 1000 <= now ? "expired" : "active";
}

export function expiryDelay(
  expSeconds: number,
  renderedStatus: "active" | "expired" | "revoked",
  nowMs = Date.now(),
): number | null {
  if (renderedStatus !== "active") return null;
  return Math.min(Math.max(expSeconds * 1000 - nowMs, 0), 2147483647);
}

export function categoriesText(categories: string[] | null) {
  if (categories === null) return "All categories";
  if (categories.length === 0) return "No categories";
  return categories.join(", ");
}

export function policyText(policy: "auto" | "ask") {
  return policy === "auto"
    ? "Automatic placement allowed, subject to other checks"
    : "Ask for approval";
}

export function substitutionText(policy: MandateLimits["substitutions"]) {
  return policy === "never" ? "Substitute offers are not allowed" : policyText(policy);
}

export function thresholdText(
  threshold: MandateLimits["minDeliveryReliability"],
  format: (value: number) => string,
) {
  return threshold === null
    ? "No threshold set"
    : `${format(threshold.value)}. If data is missing: ${policyText(threshold.ifNoData)}.`;
}

/** The shared plain source throws this exact message for this endpoint's 404 only. */
export function isNoCurrentMandate(error: unknown) {
  return error instanceof Error && error.message === "GET /api/mandates/current answered 404.";
}
