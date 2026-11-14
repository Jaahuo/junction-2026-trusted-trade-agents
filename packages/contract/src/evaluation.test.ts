import { expect, test } from "bun:test";
import { ok } from "@app/kernel";
import {
  ERROR_STATUS,
  EvaluationSchema,
  fixtures,
  type OfferVerification,
  PrecheckSchema,
} from "./index.ts";

test("ERROR_STATUS values are literal types", () => {
  // These assignments only typecheck while the table keeps its literal statuses.
  const notFound: 404 = ERROR_STATUS.NOT_FOUND;
  const upstream: 502 = ERROR_STATUS.UPSTREAM_FAILED;
  expect([notFound, upstream]).toEqual([404, 502]);
});

test("an evaluation with decision auto and a reason is rejected by the schema", () => {
  expect(EvaluationSchema.safeParse({ decision: "auto", reasons: ["NEW_PRODUCT"] }).success).toBe(
    false,
  );
  expect(EvaluationSchema.safeParse({ decision: "auto", reasons: [] }).success).toBe(true);
  expect(
    EvaluationSchema.safeParse({ decision: "needs_approval", reasons: ["NEW_PRODUCT"] }).success,
  ).toBe(true);
  expect(EvaluationSchema.safeParse({ decision: "rejected", reasons: [] }).success).toBe(true);
});

test("the pre-check is the evaluation schema, so both apply the same rule", () => {
  expect(PrecheckSchema).toBe(EvaluationSchema);
  expect(PrecheckSchema.safeParse({ decision: "auto", reasons: ["CREDIT_LIMIT"] }).success).toBe(
    false,
  );
});

test("the offer verification result type is exported from the root", () => {
  const claims = fixtures.offerClaims;
  const verified: OfferVerification = ok(claims);
  const expired: OfferVerification = { ok: false, error: { code: "OFFER_EXPIRED", claims } };
  expect(verified.ok).toBe(true);
  expect(expired.ok).toBe(false);
});
