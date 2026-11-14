import { expect, test } from "bun:test";
import { fixtures, REASON_TEXT } from "@app/contract";
import { errorSummary, orderSummary, pendingSummary } from "./summary.ts";

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
