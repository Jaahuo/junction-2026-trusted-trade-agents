import { expect, test } from "bun:test";
import { fixtures, REASON_TEXT } from "@app/contract";
import {
  draftSummary,
  errorSummary,
  orderSummary,
  pendingSummary,
  searchSummary,
} from "./summary.ts";

test("a pending order summary names the reasons and the approval URL", () => {
  const text = orderSummary(fixtures.order);
  expect(text).toContain("pending_approval");
  expect(text).toContain(REASON_TEXT.NEW_PRODUCT);
  expect(text).toContain(`${fixtures.order.approvalUrl}`);
});

test("a declined order's text states decision, next, note, originalRequest and each line with product, qty and price", () => {
  const text = orderSummary({
    ...fixtures.order,
    status: "declined",
    originalRequest: "Milk and bread for lunch",
    decision: {
      action: "reject",
      next: "alternatives",
      note: "Choose less expensive products",
      by: "buyer",
      at: "2026-11-14T10:05:00+00:00",
    },
    lines: [
      {
        offerId: "off_milk",
        token: "milk-token",
        claims: {
          ...fixtures.offerClaims,
          productId: "prod_milk",
          product: { ...fixtures.offerClaims.product, name: "Milk" },
          quantity: { value: 2, unit: "CT" },
          unitPrice: { net: 2.5, vatRate: 20, currency: "EUR" },
          total: { net: 5, gross: 6 },
        },
      },
      {
        offerId: "off_bread",
        token: "bread-token",
        claims: {
          ...fixtures.offerClaims,
          productId: "prod_bread",
          product: { ...fixtures.offerClaims.product, name: "Bread" },
          quantity: { value: 3, unit: "CT" },
          unitPrice: { net: 3, vatRate: 14, currency: "EUR" },
          total: { net: 9, gross: 10.26 },
        },
      },
    ],
  });
  expect(text).toContain("Decision: reject; next: alternatives");
  expect(text).toContain("Note: Choose less expensive products");
  expect(text).toContain("Original request: Milk and bread for lunch");
  expect(text).toContain(
    "Milk (prod_milk): 2 CT, unit price 2.50 EUR net (VAT 20%), line price 6.00 EUR gross",
  );
  expect(text).toContain(
    "Bread (prod_bread): 3 CT, unit price 3.00 EUR net (VAT 14%), line price 10.26 EUR gross",
  );
  expect(text).toContain("Search for alternatives and submit a replacement order for approval.");
});

test("a declined order with next=stop says stop and not to look for alternatives", () => {
  const text = orderSummary({
    ...fixtures.order,
    status: "declined",
    decision: {
      action: "reject",
      next: "stop",
      note: null,
      by: "buyer",
      at: "2026-11-14T10:05:00+00:00",
    },
  });
  expect(text).toContain("Decision: reject; next: stop");
  expect(text).toContain("Stop and do not look for alternatives.");
  expect(text).not.toContain("submit a replacement order");
});

const note = (availability?: { checked: boolean; dropped: number }) =>
  searchSummary({ ...fixtures.searchResult, candidates: [], availability }).split("\n");

test("a search summary says how many matches the availability filter left out, or that it did not run", () => {
  expect(note()).toEqual(["0 candidate products."]);
  expect(note({ checked: true, dropped: 0 })).toEqual(["0 candidate products."]);
  expect(note({ checked: true, dropped: 3 })).toEqual([
    "0 candidate products.",
    "3 matches left out: they cannot be delivered by the requested date.",
  ]);
  expect(note({ checked: false, dropped: 0 })).toEqual([
    "0 candidate products.",
    "Live availability was not read.",
  ]);
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
