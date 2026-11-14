import type { MandateLimits, StoredMandate } from "@app/contract";
import { pick } from "../../shared/locale.ts";
import { MANDATE } from "./strings.ts";

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
  const text = pick(MANDATE);
  if (categories === null) return text.allCategories;
  if (categories.length === 0) return text.noCategories;
  return categories.join(", ");
}

export function policyText(policy: "auto" | "ask") {
  const text = pick(MANDATE);
  return policy === "auto" ? text.autoPolicy : text.askPolicy;
}

export function substitutionText(policy: MandateLimits["substitutions"]) {
  return policy === "never" ? pick(MANDATE).noSubstitutes : policyText(policy);
}

export function thresholdText(
  threshold: MandateLimits["minDeliveryReliability"],
  format: (value: number) => string,
) {
  const text = pick(MANDATE);
  return threshold === null
    ? text.noThreshold
    : text.threshold(format(threshold.value), policyText(threshold.ifNoData));
}

/** The shared plain source throws this exact message for this endpoint's 404 only. */
export function isNoCurrentMandate(error: unknown) {
  return error instanceof Error && error.message === "GET /api/mandates/current answered 404.";
}
