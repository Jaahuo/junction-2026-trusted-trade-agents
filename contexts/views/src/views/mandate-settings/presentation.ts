import type {
  DraftMandateRequest,
  MandateDraft,
  MandateLimits,
  SoftConstraint,
  StoredMandate,
} from "@app/contract";
import { formatMoney, formatQuantity, formatTimestamp, ORDER_WORDING } from "@app/ui/format";
import { lang, pick } from "../../shared/locale.ts";
import { MANDATE } from "./strings.ts";

/** A draft_mandate result, as against a get_mandate or register_mandate result. */
export function isDraft(data: StoredMandate | MandateDraft): data is MandateDraft {
  return "draft" in data;
}

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

export function percentText(value: number) {
  return new Intl.NumberFormat(lang() === "fi" ? "fi-FI" : "en-FI", {
    style: "percent",
    maximumFractionDigits: 4,
  }).format(value);
}

export function co2Text(value: number) {
  return pick(MANDATE).co2PerKg(formatQuantity({ value, unit: "KGM" }, lang()));
}

export function softText(item: SoftConstraint) {
  const text = pick(MANDATE);
  const label =
    item.attribute === "countryOfOrigin"
      ? text.countryOfOrigin
      : item.attribute === "category"
        ? text.category
        : item.attribute;
  return `${label}: ${item.prefer}`;
}

function epochText(seconds: number) {
  return formatTimestamp(new Date(seconds * 1000).toISOString(), lang());
}

/** Short label and value pairs of a mandate's terms; `exp` undefined means the default lifetime. */
function termValues(terms: DraftMandateRequest) {
  const text = pick(MANDATE);
  const { limits, standingConstraints: standing } = terms;
  const { maxOrderTotal: max } = limits;
  const list = (items: string[]) => (items.length === 0 ? text.none : items.join(", "));
  return [
    [pick(ORDER_WORDING).terms.limit, formatMoney(max.value, max.currency, max.basis, lang())],
    [text.categories, categoriesText(limits.categories)],
    [text.substitutions, substitutionText(limits.substitutions)],
    [text.newProducts, policyText(limits.newProducts)],
    [text.minReliability, thresholdText(limits.minDeliveryReliability, percentText)],
    [text.maxCo2, thresholdText(limits.maxCo2PerKg, co2Text)],
    [text.missingAllergen, policyText(limits.allergenData.ifNoData)],
    [text.invoice, policyText(limits.paymentTerms.invoice)],
    [pick(ORDER_WORDING).terms.paymentOnOrder, policyText(limits.paymentTerms.pay_on_order)],
    [text.required, list(standing.hard.map(() => text.freeFromLactose))],
    [text.preferred, list(standing.soft.map(softText))],
    [text.expires, terms.exp === undefined ? text.oneYear : epochText(terms.exp)],
  ] as const;
}

export type DraftRow = { label: string; proposed: string; current: string | null };

/** Each proposed term next to the term in force; `current` is null without a current mandate or when it is the same. */
export function draftRows({ draft, current }: MandateDraft): DraftRow[] {
  const now = current === null ? null : termValues(current.mandate);
  return termValues(draft).map(([label, proposed], index) => {
    const value = now?.[index]?.[1] ?? null;
    return { label, proposed, current: value === proposed ? null : value };
  });
}

/** The register_mandate input for a draft; one operationId per draft makes a retry a replay. */
export function registerInput(draft: DraftMandateRequest, operationId: string) {
  return { ...draft, operationId };
}

/** What the model learns when the human registers the draft in the view. */
export function registeredContext({ mandate }: StoredMandate) {
  return `The human registered mandate ${mandate.mandateId} version ${mandate.version} in the mandate view. Its limits are in force now.`;
}
