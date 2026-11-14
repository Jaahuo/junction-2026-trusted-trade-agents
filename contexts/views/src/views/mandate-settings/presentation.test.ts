import { expect, test } from "bun:test";
import { fixtures, type StoredMandate } from "@app/contract";
import { setLang } from "../../shared/locale.ts";
import {
  categoriesText,
  draftRows,
  inForce,
  effectiveStatus,
  expiryDelay,
  isDraft,
  isNoCurrentMandate,
  policyText,
  registeredContext,
  registerInput,
  registersDraft,
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

test("a draft result is told apart from a stored mandate", () => {
  expect(isDraft(fixtures.mandateDraft)).toBe(true);
  expect(isDraft(fixtures.storedMandate)).toBe(false);
});

test("draft rows show the value in force only where it differs", () => {
  setLang("en");
  const rows = draftRows(fixtures.mandateDraft);
  const limit = rows[0];
  expect(limit?.proposed).toContain("500");
  expect(limit?.current).toMatch(/^1\D000/);
  expect(rows.find((row) => row.label === "Categories")).toEqual({
    label: "Categories",
    proposed: "All categories",
    current: null,
  });
  expect(rows.find((row) => row.label === "Preferred")?.proposed).toBe(
    "Country of origin: Finland",
  );
  expect(rows.at(-1)).toMatchObject({ label: "Expires", proposed: "One year after registration" });
  expect(rows.at(-1)?.current).not.toBeNull();
});

test("draft rows without a current mandate have no value in force", () => {
  const rows = draftRows({ ...fixtures.mandateDraft, current: null });
  expect(rows.every((row) => row.current === null)).toBe(true);
  expect(rows).toHaveLength(12);
});

test("the register input is the draft with the operationId", () => {
  expect(registerInput(fixtures.draftMandateRequest, "op_view_1")).toEqual({
    ...fixtures.draftMandateRequest,
    operationId: "op_view_1",
  });
});

test("inForce keeps the current mandate only while it is active", () => {
  const exp = fixtures.storedMandate.mandate.exp;
  expect(inForce(fixtures.mandateDraft, (exp - 1) * 1000)).toEqual(fixtures.storedMandate);
  expect(inForce(fixtures.mandateDraft, exp * 1000)).toBeNull();
  const revoked = { ...fixtures.storedMandate, status: "revoked" as const };
  expect(inForce({ ...fixtures.mandateDraft, current: revoked }, 0)).toBeNull();
});

test("registersDraft matches a new active mandate with the draft's terms in any key order", () => {
  const { draft } = fixtures.mandateDraft;
  const limits = Object.fromEntries(Object.entries(draft.limits).toReversed());
  const stored: StoredMandate = {
    ...fixtures.storedMandate,
    mandate: {
      ...fixtures.storedMandate.mandate,
      mandateId: "mnd_new",
      version: 2,
      limits: { ...draft.limits, ...limits },
    },
  };
  const now = (stored.mandate.exp - 1) * 1000;
  expect(registersDraft(stored, fixtures.mandateDraft, now)).toBe(true);
  expect(registersDraft(fixtures.storedMandate, fixtures.mandateDraft, now)).toBe(false);
  expect(registersDraft({ ...stored, status: "revoked" }, fixtures.mandateDraft, now)).toBe(false);
  expect(
    registersDraft(stored, { ...fixtures.mandateDraft, draft: { ...draft, exp: 5 } }, now),
  ).toBe(false);
});

test("registeredContext says in force only for an active mandate", () => {
  const exp = fixtures.storedMandate.mandate.exp;
  expect(registeredContext(fixtures.storedMandate, (exp - 1) * 1000)).toContain("in force now");
  expect(registeredContext(fixtures.storedMandate, exp * 1000)).toContain(
    "expired and not in force",
  );
  expect(registeredContext({ ...fixtures.storedMandate, status: "revoked" }, 0)).toContain(
    "revoked and not in force",
  );
});
