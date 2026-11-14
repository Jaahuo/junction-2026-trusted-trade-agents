import { expect, test } from "bun:test";
import { type ErrorCode, fixtures, type OmitReason, type Order } from "@app/contract";
import type { AnyElysia } from "elysia";
import { cents, claimsOf, mountWithOffers } from "./fake-offers.ts";
import { withDatabase } from "./test-database.ts";
import { call, counts, errorOf, inMinutes, orderOf, overLimit, place } from "./test-support.ts";

const PRODUCT = fixtures.offerClaims.productId;
const SUBSTITUTE = "prod_test_substitute";
const OTHER_SUBSTITUTE = "prod_test_other_substitute";

const decide = (
  app: AnyElysia,
  order: Order,
  body: object,
  proposalVersion = order.proposalVersion,
) => call(app, "POST", `/${order.orderId}/decision`, { proposalVersion, ...body });

const amount = (value: number) => [{ productId: PRODUCT, quantity: { value, unit: "CT" } }];

const pendingOrder = async (app: AnyElysia, offers: string[], extra: object = {}) => {
  const order = await orderOf(await place(app, offers, extra));
  expect(order.status).toBe("pending_approval");
  return order;
};

const edited = (order: Order) =>
  order.audit.filter((event) => event.event === "edited").map((event) => event.detail);

test("edit with a smaller amount issues a new offer, re-checks, and places when no reason remains", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const token = await sign(overLimit);
    const pending = await pendingOrder(app, [token]);

    const response = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(offers.calls).toEqual([{ tokens: [token], changes: amount(2) }]);
    expect(order).toMatchObject({
      status: "placed",
      reasons: [],
      proposalVersion: 2,
      total: { net: 550, gross: 625 },
      approvalUrl: null,
      decision: { action: "edit", next: null },
    });
    expect(order.lines.map((line) => line.claims.quantity.value)).toEqual([2]);
    expect(order.offerIds).not.toContain(pending.offerIds[0]);
    expect(order.requotes.map((entry) => entry.previous.offerId)).toEqual(pending.offerIds);
    expect(edited(order)).toEqual([`${fixtures.offerClaims.product.name}: 4 → 2 CT`]);
    expect(order.audit.at(-1)?.event).toBe("placed");
    expect((await counts(db)).history).toBe(1);
  }));

test("edit that raises the total over the limit keeps the order pending with SPEND_OVER_LIMIT and proposalVersion + 1", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    // Under the spend limit, but the CO2 limit sends it to approval.
    const highCo2 = { product: { ...fixtures.offerClaims.product, co2PerKg: 99 } };
    const pending = await pendingOrder(app, [await sign(highCo2)]);
    expect(pending.reasons).not.toContain("SPEND_OVER_LIMIT");

    const response = await decide(app, pending, { decision: "edit", changes: amount(80) });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order.status).toBe("pending_approval");
    expect(order.reasons).toContain("SPEND_OVER_LIMIT");
    expect(order.proposalVersion).toBe(2);
    expect(order.decision).toBeNull();
    expect(order.approvalUrl).toContain(order.orderId);
    expect(order.audit.at(-1)?.event).toBe("sent_to_approval");
    expect((await counts(db)).history).toBe(0);

    // The next decision must name the new proposal.
    expect((await decide(app, order, { decision: "approve" }, 1)).status).toBe(409);
    expect((await orderOf(await decide(app, order, { decision: "approve" }))).status).toBe(
      "placed",
    );
  }));

test("pick_alternative replaces the line with the chosen offered alternative and re-checks", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const alternative = await sign({ quantity: { value: 2, unit: "CT" } });
    const pending = await pendingOrder(app, [await sign(overLimit)], {
      alternatives: [alternative],
    });
    const chosen = claimsOf(alternative).offerId;

    const response = await decide(app, pending, { decision: "pick_alternative", offerId: chosen });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order).toMatchObject({ status: "placed", reasons: [], proposalVersion: 2 });
    expect(order.offerIds).toEqual([chosen]);
    expect(order.alternatives).toEqual([]);
    expect(order.requotes.map((entry) => [entry.previous.offerId, entry.current.offerId])).toEqual([
      [...pending.offerIds, chosen],
    ]);
  }));

test("a picked substitute takes the place of the substitute line and the order is checked again", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const named = (productId: string) => ({
      productId,
      replaces: PRODUCT,
      product: { ...fixtures.offerClaims.product, name: `Test ${productId}` },
    });
    const other = await sign(named(OTHER_SUBSTITUTE));
    const pending = await pendingOrder(app, [await sign(), await sign(named(SUBSTITUTE))], {
      alternatives: [other],
    });
    expect(pending.reasons).toContain("SUBSTITUTION");

    const response = await decide(app, pending, {
      decision: "pick_alternative",
      offerId: claimsOf(other).offerId,
    });
    const order = await orderOf(response);
    expect(order.lines.map((line) => line.claims.productId)).toEqual([PRODUCT, OTHER_SUBSTITUTE]);
    // The mandate asks before substituting, so the new substitute waits for approval too.
    expect(order).toMatchObject({ status: "pending_approval", proposalVersion: 2 });
    expect(order.reasons).toContain("SUBSTITUTION");
    expect(edited(order)).toEqual([`Test ${SUBSTITUTE} → Test ${OTHER_SUBSTITUTE}: 4 CT`]);
  }));

test("an alternative that the order does not hold is refused", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const elsewhere = claimsOf(await sign()).offerId;
    for (const offerId of ["off_other", elsewhere]) {
      const response = await decide(app, pending, { decision: "pick_alternative", offerId });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("BAD_REQUEST");
    }
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored).toMatchObject({ status: "pending_approval", proposalVersion: 1 });
  }));

test("a stale proposalVersion gives 409", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    for (const body of [
      { decision: "edit", changes: amount(2) },
      { decision: "pick_alternative", offerId: "off_other" },
    ]) {
      const response = await decide(app, pending, body, 2);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe("CONFLICT");
    }
    expect(offers.calls).toEqual([]);
  }));

test("two parallel edits of one proposal: one is applied, the other gives 409", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const responses = await Promise.all([
      decide(app, pending, { decision: "edit", changes: amount(5) }),
      decide(app, pending, { decision: "edit", changes: amount(6) }),
    ]);
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored.proposalVersion).toBe(2);
    expect(stored.requotes).toHaveLength(1);
  }));

test("an edit that cannot be re-offered, or offers that cannot be reached, leave the order as it was", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);

    offers.state.omit.set(PRODUCT, "INSUFFICIENT_STOCK");
    const omitted = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(omitted.status).toBe(409);
    expect(await errorOf(omitted)).toBe("CONFLICT");

    offers.state.omit.clear();
    offers.state.fail = true;
    const unreachable = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(unreachable.status).toBe(502);
    expect(await errorOf(unreachable)).toBe("UPSTREAM_FAILED");

    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored).toMatchObject({
      status: "pending_approval",
      proposalVersion: 1,
      offerIds: pending.offerIds,
    });
  }));

test("an edit to zero or of a product the order does not hold gives 400 and asks offers for nothing", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    for (const changes of [
      amount(0),
      [{ productId: "prod_test_unknown", quantity: { value: 1, unit: "CT" } }],
    ]) {
      const response = await decide(app, pending, { decision: "edit", changes });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("BAD_REQUEST");
    }
    expect(offers.calls).toEqual([]);
  }));

test("the offer an edit replaced stays used: placing it again gives 400 OFFER_INVALID", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const token = await sign(overLimit);
    const pending = await pendingOrder(app, [token]);
    expect((await decide(app, pending, { decision: "edit", changes: amount(2) })).status).toBe(200);
    const replay = await place(app, [token]);
    expect(replay.status).toBe(400);
    expect(await errorOf(replay)).toBe("OFFER_INVALID");
  }));

test("an edit whose re-quote raises the unit price keeps the order pending with PRICE_CHANGED", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    offers.state.price = 1.5;

    const response = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order).toMatchObject({ status: "pending_approval", proposalVersion: 2, decision: null });
    expect(order.reasons).toEqual(["PRICE_CHANGED"]);
    const net = fixtures.offerClaims.unitPrice.net;
    expect(edited(order)).toEqual([
      `${fixtures.offerClaims.product.name}: 4 → 2 CT, unit price ${net} → ${cents(net * 1.5)} EUR net`,
    ]);
    expect(order.requotes.at(-1)?.reasons).toEqual(["PRICE_CHANGED"]);
    expect((await counts(db)).history).toBe(0);
    const stored = await orderOf(await call(app, "GET", `/${order.orderId}`));
    expect(stored).toMatchObject({ status: "pending_approval", reasons: ["PRICE_CHANGED"] });
  }));

test("after a new mandate, an edit drops the alternatives made under the old one and goes through", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers, register } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)], {
      alternatives: [await sign({ quantity: { value: 1, unit: "CT" } })],
    });
    const current = await register();
    offers.state.mandate = current;

    const response = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order).toMatchObject({ status: "placed", mandateId: current.mandateId });
    expect(order.alternatives).toEqual([]);
  }));

test("a line the re-quote omits answers by its reason and leaves the order as it was", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const cases: [OmitReason | null, number, ErrorCode][] = [
      ["INVALID_QUANTITY", 400, "BAD_REQUEST"],
      ["CONSTRAINT_CONTRADICTED", 400, "BAD_REQUEST"],
      ["SALES_BLOCKED", 409, "CONFLICT"],
      ["NO_PRICE", 409, "CONFLICT"],
      ["UNKNOWN_PRODUCT", 409, "CONFLICT"],
      [null, 502, "UPSTREAM_FAILED"],
    ];
    for (const [reason, status, code] of cases) {
      offers.state.omit.set(PRODUCT, reason);
      const response = await decide(app, pending, { decision: "edit", changes: amount(2) });
      expect({ reason, status: response.status, code: await errorOf(response) }).toEqual({
        reason,
        status,
        code,
      });
    }
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored).toMatchObject({ proposalVersion: 1, offerIds: pending.offerIds });
  }));

test("a re-quote that reuses an offer or sends a token that fails verification gives 502", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    for (const fault of ["reuse", "broken"] as const) {
      offers.state[fault] = true;
      // The same amount, so only the offer ID can show that the answer is stale.
      const response = await decide(app, pending, { decision: "edit", changes: amount(4) });
      expect({ fault, status: response.status, code: await errorOf(response) }).toEqual({
        fault,
        status: 502,
        code: "UPSTREAM_FAILED",
      });
      offers.state[fault] = false;
    }
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored).toMatchObject({ proposalVersion: 1, offerIds: pending.offerIds });
  }));

test("an edit that changes a product twice, or a product on two lines, gives 400", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const twice = await pendingOrder(app, [await sign(overLimit)]);
    const doubled = await decide(app, twice, {
      decision: "edit",
      changes: [...amount(2), ...amount(3)],
    });
    expect(doubled.status).toBe(400);
    const twoLines = await pendingOrder(app, [await sign(overLimit), await sign()]);
    const shared = await decide(app, twoLines, { decision: "edit", changes: amount(2) });
    expect(shared.status).toBe(400);
    expect(offers.calls).toEqual([]);
  }));

test("an edit of an order with a substitute line keeps SUBSTITUTION, and approve then places it", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const substitute = await sign({
      productId: SUBSTITUTE,
      replaces: PRODUCT,
      product: { ...fixtures.offerClaims.product, name: `Test ${SUBSTITUTE}` },
    });
    const pending = await pendingOrder(app, [await sign(), substitute]);
    expect(pending.reasons).toContain("SUBSTITUTION");

    const response = await decide(app, pending, { decision: "edit", changes: amount(2) });
    const order = await orderOf(response);
    expect(order.lines.map((line) => [line.claims.productId, line.claims.replaces])).toEqual([
      [PRODUCT, null],
      [SUBSTITUTE, PRODUCT],
    ]);
    expect(order.offerIds.filter((id) => pending.offerIds.includes(id))).toEqual([]);
    expect(order).toMatchObject({ status: "pending_approval", proposalVersion: 2 });
    expect(order.reasons).toContain("SUBSTITUTION");
    expect((await orderOf(await decide(app, order, { decision: "approve" }))).status).toBe(
      "placed",
    );
  }));

test("an alternative already used by another order is refused when picked", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const shared = await sign({ quantity: { value: 1, unit: "CT" } });
    const first = await pendingOrder(app, [await sign(overLimit)], { alternatives: [shared] });
    const second = await pendingOrder(app, [await sign(overLimit)], { alternatives: [shared] });
    const offerId = claimsOf(shared).offerId;
    expect((await decide(app, first, { decision: "pick_alternative", offerId })).status).toBe(200);

    const response = await decide(app, second, { decision: "pick_alternative", offerId });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("OFFER_INVALID");
    const stored = await orderOf(await call(app, "GET", `/${second.orderId}`));
    expect(stored).toMatchObject({ status: "pending_approval", proposalVersion: 1 });
  }));

test("an edit after the mandate was revoked rejects the order with MANDATE_INVALID", async () =>
  withDatabase(async (db) => {
    const { app, sign, mandates, mandate } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const revoked = await mandates.handle(
      new Request(`http://localhost/mandates/${mandate.mandateId}/revoke`, { method: "POST" }),
    );
    expect(revoked.ok).toBe(true);

    const order = await orderOf(
      await decide(app, pending, { decision: "edit", changes: amount(2) }),
    );
    expect(order).toMatchObject({ status: "rejected", decision: { action: "edit" } });
    expect(order.reasons).toContain("MANDATE_INVALID");
    expect((await counts(db)).history).toBe(0);
    const stored = await orderOf(await call(app, "GET", `/${order.orderId}`));
    expect(stored).toMatchObject({ status: "rejected", reasons: order.reasons });
  }));

test("an edit or pick of an order that is no longer pending gives 409", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const placed = await orderOf(await decide(app, pending, { decision: "approve" }));
    expect(placed.status).toBe("placed");
    for (const body of [
      { decision: "edit", changes: amount(2) },
      { decision: "pick_alternative", offerId: "off_other" },
    ]) {
      const response = await decide(app, pending, body, placed.proposalVersion);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe("CONFLICT");
    }
    expect(offers.calls).toEqual([]);
  }));

test("picking an alternative that has expired gives 409 OFFER_EXPIRED and leaves the order pending", async () =>
  withDatabase(async (db) => {
    const { app, sign, clock } = await mountWithOffers(db);
    const alternative = await sign({ quantity: { value: 2, unit: "CT" } }, inMinutes(1));
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(60))], {
      alternatives: [alternative],
    });
    clock.now = inMinutes(5);

    const response = await decide(app, pending, {
      decision: "pick_alternative",
      offerId: claimsOf(alternative).offerId,
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe("OFFER_EXPIRED");
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored).toMatchObject({ status: "pending_approval", proposalVersion: 1 });
  }));

const B = "prod_test_b";
const productB = { productId: B, product: { ...fixtures.offerClaims.product, name: "Test b" } };

test("two edits in a row keep every replaced offer used", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const token = await sign(overLimit);
    const pending = await pendingOrder(app, [token]);
    const first = await orderOf(
      await decide(app, pending, { decision: "edit", changes: amount(5) }),
    );
    expect(first).toMatchObject({ status: "pending_approval", proposalVersion: 2 });
    const second = await orderOf(
      await decide(app, first, { decision: "edit", changes: amount(6) }),
    );
    expect(second).toMatchObject({ status: "pending_approval", proposalVersion: 3 });
    expect(second.requotes.map((entry) => entry.previous.offerId)).toEqual([
      ...pending.offerIds,
      ...first.offerIds,
    ]);
    // The first proposal's own audit stays in front of the edits.
    expect(second.audit.slice(0, 2).map((event) => event.event)).toEqual([
      "order_requested",
      "offer_verified",
    ]);
    expect(second.audit.map((event) => event.event)).toContain("sent_to_approval");
    expect(edited(second)).toHaveLength(2);
    for (const replaced of [token, first.lines[0]?.token ?? ""]) {
      const replay = await place(app, [replaced]);
      expect(replay.status).toBe(400);
      expect(await errorOf(replay)).toBe("OFFER_INVALID");
    }
  }));

test("a higher price on a line the approver did not change keeps the order pending with PRICE_CHANGED for that product", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit), await sign(productB)]);
    offers.state.priceOf.set(B, 1.2);

    const order = await orderOf(
      await decide(app, pending, { decision: "edit", changes: amount(1) }),
    );
    expect(order.status).toBe("pending_approval");
    expect(order.reasons).toContain("PRICE_CHANGED");
    const priced = order.audit.filter(
      (event) => event.event === "check_failed" && event.reason === "PRICE_CHANGED",
    );
    expect(priced.map((event) => event.productId)).toEqual([B]);
  }));

test("an edit after the original offers expired re-quotes them and goes through", async () =>
  withDatabase(async (db) => {
    const { app, sign, clock } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(1))]);
    clock.now = inMinutes(5);

    const response = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(response.status).toBe(200);
    expect((await orderOf(response)).status).toBe("placed");
  }));

test("a line the approver did not change that cannot be offered again gives 409 with its reason", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit), await sign(productB)]);
    offers.state.omit.set(B, "CONSTRAINT_CONTRADICTED");

    const response = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe("CONFLICT");
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored).toMatchObject({ proposalVersion: 1, offerIds: pending.offerIds });
  }));

test("a re-quote that ignores the asked amount or date gives 502, and an applied date is kept", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const later = { productId: PRODUCT, deliverBy: "2026-11-30" };

    offers.state.ignore = "quantity";
    const amountIgnored = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(amountIgnored.status).toBe(502);
    offers.state.ignore = "deliverBy";
    const dateIgnored = await decide(app, pending, { decision: "edit", changes: [later] });
    expect(dateIgnored.status).toBe(502);

    offers.state.ignore = null;
    const applied = await orderOf(
      await decide(app, pending, { decision: "edit", changes: [later] }),
    );
    expect(applied.lines.map((line) => line.claims.requestedDate)).toEqual([later.deliverBy]);
  }));

test("a picked substitute for a product the order holds is added beside that line", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const substitute = await sign({
      productId: SUBSTITUTE,
      replaces: PRODUCT,
      quantity: { value: 1, unit: "CT" },
      product: { ...fixtures.offerClaims.product, name: `Test ${SUBSTITUTE}` },
    });
    const pending = await pendingOrder(app, [await sign(overLimit)], {
      alternatives: [substitute],
    });

    const order = await orderOf(
      await decide(app, pending, {
        decision: "pick_alternative",
        offerId: claimsOf(substitute).offerId,
      }),
    );
    expect(order.lines.map((line) => line.claims.productId)).toEqual([PRODUCT, SUBSTITUTE]);
    expect(edited(order)).toEqual([`Test ${SUBSTITUTE}: added`]);
    expect(order.requotes).toEqual([]);
    expect(order.reasons).toContain("SUBSTITUTION");
  }));

test("an edit keeps an alternative made under the current mandate and drops an expired one, with an audit entry", async () =>
  withDatabase(async (db) => {
    const { app, sign, clock } = await mountWithOffers(db);
    const lasting = await sign({ quantity: { value: 1, unit: "CT" } }, inMinutes(60));
    const brief = await sign({ quantity: { value: 2, unit: "CT" } }, inMinutes(1));
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(60))], {
      alternatives: [lasting, brief],
    });
    clock.now = inMinutes(5);

    const order = await orderOf(
      await decide(app, pending, { decision: "edit", changes: amount(5) }),
    );
    expect(order.alternatives.map((line) => line.token)).toEqual([lasting]);
    expect(
      order.audit.some(
        (event) =>
          event.actor === "server" &&
          event.event === "edited" &&
          /1 alternative/.test(event.detail ?? ""),
      ),
    ).toBe(true);
  }));

test("after the account's payment terms changed, an edit or pick gives 409 and asks offers for nothing", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const alternative = await sign({ quantity: { value: 1, unit: "CT" } });
    const pending = await pendingOrder(app, [await sign(overLimit)], {
      alternatives: [alternative],
    });
    // The account now pays on order; the stored offers still say invoice.
    await db.$client.unsafe(
      `update orders_orders set lines = to_jsonb(replace(lines #>> '{}', '"invoice"', '"pay_on_order"'))`,
    );
    for (const body of [
      { decision: "edit", changes: amount(2) },
      { decision: "pick_alternative", offerId: claimsOf(alternative).offerId },
    ]) {
      const response = await decide(app, pending, body);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe("CONFLICT");
    }
    expect(offers.calls).toEqual([]);
  }));
