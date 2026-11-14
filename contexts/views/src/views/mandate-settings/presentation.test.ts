import { expect, test } from "bun:test";
import type { StoredMandate } from "@app/contract";
import {
  categoriesText,
  effectiveStatus,
  expiryDelay,
  isNoCurrentMandate,
  policyText,
  substitutionText,
  thresholdText,
} from "./presentation.ts";

const record: StoredMandate = {
  mandate: {
    iss: "customer_example",
    mandateId: "mandate_example",
    version: 1,
    agent: "agent_example",
    signedBy: "approver_example",
    iat: 100,
    exp: 200,
    limits: {
      maxOrderTotal: { value: 100, currency: "EUR", basis: "gross" },
      categories: null,
      substitutions: "ask",
      newProducts: "ask",
      minDeliveryReliability: null,
      maxCo2PerKg: null,
      allergenData: { ifNoData: "ask" },
      paymentTerms: { invoice: "auto", pay_on_order: "ask" },
    },
    standingConstraints: { hard: [], soft: [] },
  },
  status: "active",
  jws: null,
  registeredAt: "2026-01-01T00:00:00Z",
};

test("status respects expiry boundary and revocation takes precedence", () => {
  expect(effectiveStatus(record, 199999)).toBe("active");
  expect(effectiveStatus(record, 200000)).toBe("expired");
  expect(effectiveStatus({ ...record, status: "revoked" }, 199999)).toBe("revoked");
  expect(effectiveStatus({ ...record, status: "revoked" }, 200000)).toBe("revoked");
});

test("expiry scheduling follows the rendered snapshot across the boundary", () => {
  for (const [now, activeDelay] of [
    [199999, 1],
    [200000, 0],
    [200001, 0],
  ] as const) {
    expect(expiryDelay(200, "active", now)).toBe(activeDelay);
    expect(expiryDelay(200, "expired", now)).toBeNull();
    expect(expiryDelay(200, "revoked", now)).toBeNull();
  }

  expect(expiryDelay(3_000_000, "active", 0)).toBe(2147483647);
});

test("category scope distinguishes all, none and literal codes", () => {
  expect(categoriesText(null)).toBe("All categories");
  expect(categoriesText([])).toBe("No categories");
  expect(categoriesText(["dairy", "X-12"])).toBe("dairy, X-12");
});

test("policy and missing data describe approval without promising placement", () => {
  expect(policyText("ask")).toBe("Ask for approval");
  expect(policyText("auto")).toContain("subject to other checks");
  expect(substitutionText("ask")).toBe(policyText("ask"));
  expect(substitutionText("auto")).toBe(policyText("auto"));
  expect(thresholdText(null, String)).toBe("No threshold set");
  expect(thresholdText({ value: 0, ifNoData: "ask" }, String)).toContain(
    "0. If data is missing: Ask for approval",
  );
  expect(thresholdText({ value: 0.9, ifNoData: "auto" }, String)).toContain(
    "subject to other checks",
  );
});

test("only the current mandate endpoint's 404 is empty", () => {
  expect(isNoCurrentMandate(new Error("GET /api/mandates/current answered 404."))).toBe(true);
  expect(isNoCurrentMandate(new Error("GET /api/mandates/current answered 500."))).toBe(false);
  expect(isNoCurrentMandate(new Error("GET /other answered 404."))).toBe(false);
  expect(isNoCurrentMandate(null)).toBe(false);
});
