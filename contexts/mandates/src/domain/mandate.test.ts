import { expect, test } from "bun:test";
import { fixtures, type Principal } from "@app/contract";
import { buildMandate, checkTerms, isCurrent } from "./mandate.ts";

const principal: Principal = {
  accountId: "acct_test",
  label: "Test kitchen",
  customer: "cust_test",
  agentId: "agent_test",
  paymentTerms: "invoice",
  creditLimit: 100,
};
const now = new Date("2026-11-14T10:00:00.500Z");
const iat = 1_794_650_400;

test("buildMandate takes iss, agent and signedBy from the principal and sets version, iat and a one-year exp", () => {
  const mandate = buildMandate({
    principal,
    request: { ...fixtures.registerMandateRequest, exp: undefined },
    mandateId: "mnd_1",
    previousVersion: 2,
    now,
  });
  expect(mandate).toEqual({
    iss: "cust_test",
    mandateId: "mnd_1",
    version: 3,
    agent: "agent_test",
    signedBy: "acct_test",
    limits: fixtures.registerMandateRequest.limits,
    standingConstraints: fixtures.registerMandateRequest.standingConstraints,
    iat,
    exp: iat + 365 * 24 * 60 * 60,
  });
});

test("buildMandate keeps a requested exp", () => {
  const request = { ...fixtures.registerMandateRequest, exp: iat + 60 };
  expect(
    buildMandate({ principal, request, mandateId: "mnd_1", previousVersion: 0, now }).exp,
  ).toBe(iat + 60);
});

test("isCurrent is true only for an active mandate before its exp", () => {
  const stored = fixtures.storedMandate;
  const exp = stored.mandate.exp;
  expect(isCurrent(stored, new Date((exp - 1) * 1000))).toBe(true);
  expect(isCurrent(stored, new Date(exp * 1000))).toBe(false);
  expect(isCurrent({ ...stored, status: "revoked" }, new Date((exp - 1) * 1000))).toBe(false);
});

test("checkTerms accepts no exp or an exp after now and refuses an exp at or before now", () => {
  const { operationId: _operationId, ...draft } = fixtures.registerMandateRequest;
  expect(checkTerms(draft, now)).toEqual({ ok: true, value: draft });
  expect(checkTerms({ ...draft, exp: iat + 1 }, now).ok).toBe(true);
  for (const exp of [iat, iat - 1])
    expect(checkTerms({ ...draft, exp }, now)).toEqual({ ok: false, error: "expired" });
});
