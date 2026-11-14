import { expect, test } from "bun:test";
import { fixtures, REASON_TEXT } from "@app/contract";
import { draftSummary, errorSummary, orderSummary, pendingSummary } from "./summary.ts";

test("a pending order summary names the reasons and the approval URL", () => {
  const text = orderSummary(fixtures.order);
  expect(text).toContain("pending_approval");
  expect(text).toContain(REASON_TEXT.NEW_PRODUCT);
  expect(text).toContain(`${fixtures.order.approvalUrl}`);
});

test("a placed order summary has no approval URL", () => {
  const text = orderSummary({ ...fixtures.order, status: "placed" });
  expect(text).not.toContain(`${fixtures.order.approvalUrl}`);
});

test("the pending list summary links each order's approval page", () => {
  expect(pendingSummary(fixtures.pendingList)).toContain(`${fixtures.order.approvalUrl}`);
});

test("an error summary has the code, the message and the next delivery date", () => {
  expect(errorSummary(fixtures.errorEnvelope)).toBe(
    "STALE_OFFER: Request new offers. Next delivery date: 2026-11-20.",
  );
});

test("a draft summary says it is not registered, names the current limit and sends the human to Register", () => {
  const text = draftSummary(fixtures.mandateDraft);
  expect(text).toContain("not registered");
  expect(text).toContain("500.00 EUR gross");
  expect(text).toContain(
    `${fixtures.storedMandate.mandate.mandateId} version 1 allows 1000.00 EUR gross`,
  );
  expect(text).toContain("press Register");
  expect(text).toContain("get_mandate");
});

test("a draft summary without a current mandate says so", () => {
  expect(draftSummary({ ...fixtures.mandateDraft, current: null })).toContain(
    "There is no current mandate.",
  );
});
