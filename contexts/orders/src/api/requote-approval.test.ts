import { expect, test } from "bun:test";
import { ErrorEnvelopeSchema, fixtures, type Order } from "@app/contract";
import type { AnyElysia } from "elysia";
import { postgresOrderStore } from "../infra/order-store.ts";
import { mountWithOffers } from "./fake-offers.ts";
import { withDatabase } from "./test-database.ts";
import {
  call,
  counts,
  errorOf,
  inMinutes,
  limitsWith,
  orderOf,
  overLimit,
  place,
} from "./test-support.ts";

const approve = (app: AnyElysia, order: Order, proposalVersion = order.proposalVersion) =>
  call(app, "POST", `/${order.orderId}/decision`, { decision: "approve", proposalVersion });

const pendingOrder = async (app: AnyElysia, offers: string[]) => {
  const order = await orderOf(await place(app, offers));
  expect(order.status).toBe("pending_approval");
  return order;
};

const events = (order: Order) => order.audit.map(({ actor, event }) => `${actor}:${event}`);

/** The date `days` after `base`, both YYYY-MM-DD. */
const day = (base: string, days: number) => {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

test("an expired pending offer is re-quoted on approve; same or lower price replaces it with requoted", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);

    const response = await approve(app, pending);
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order.status).toBe("placed");
    expect(offers.calls).toHaveLength(1);
    expect(order.offerIds).not.toContain(pending.offerIds[0]);
    expect(order.requotes).toHaveLength(1);
    expect(order.requotes[0]?.previous.offerId).toBe(pending.offerIds[0]);
    expect(order.proposalVersion).toBe(pending.proposalVersion + 1);
    expect(events(order)).toEqual(
      expect.arrayContaining(["server:requoted", "approver:approved", "server:placed"]),
    );
    expect(events(order).indexOf("server:requoted")).toBeLessThan(
      events(order).indexOf("approver:approved"),
    );
    expect(order.receipt).toBeString();
    expect((await counts(db)).history).toBe(1);

    // The replaced offer stays consumed: it cannot be placed again.
    const replay = await place(app, [pending.lines[0]?.token ?? ""]);
    expect(replay.status).toBe(400);
    expect(await errorOf(replay)).toBe("OFFER_INVALID");
  }));

test("a higher price adds PRICE_CHANGED, a Requote entry and proposalVersion + 1", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.price = 1.5;

    const response = await approve(app, pending);
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order.status).toBe("pending_approval");
    expect(order.reasons).toContain("PRICE_CHANGED");
    expect(order.requotes).toHaveLength(1);
    expect(order.proposalVersion).toBe(pending.proposalVersion + 1);
    expect(order.decision).toBeNull();
    expect(events(order)).toContain("server:requoted");
    expect(events(order)).not.toContain("approver:approved");
    expect((await counts(db)).history).toBe(0);
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored.status).toBe("pending_approval");
    expect(stored.proposalVersion).toBe(pending.proposalVersion + 1);

    // The old proposal is gone; approving the new one places it at the new price, without a re-quote.
    expect((await approve(app, pending)).status).toBe(409);
    const placed = await orderOf(await approve(app, order));
    expect(placed.status).toBe("placed");
    expect(offers.calls).toHaveLength(1);
  }));

test("lines under an older mandate are re-quoted under the current one", async () =>
  withDatabase(async (db) => {
    const { app, register, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const current = await register(limitsWith());
    offers.state.mandate = { mandateId: current.mandateId, version: current.version };

    const response = await approve(app, pending);
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order.status).toBe("placed");
    expect(order.lines[0]?.claims.mandateVersion).toBe(current.version);
    expect(order.mandateVersion).toBe(current.version);
    expect(order.requotes[0]?.previous.mandateVersion).toBe(pending.mandateVersion ?? -1);
  }));

test("a re-quote at approval that offers cannot answer gives 502 and the order stays pending", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.fail = true;

    const response = await approve(app, pending);
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe("UPSTREAM_FAILED");
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored.status).toBe("pending_approval");
    expect(stored.proposalVersion).toBe(pending.proposalVersion);
    expect((await counts(db)).history).toBe(0);
  }));

test("a re-quote at a higher price stays pending even when the order already listed PRICE_CHANGED and SPEND_OVER_LIMIT", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    expect(pending.reasons).toContain("SPEND_OVER_LIMIT");
    clock.now = inMinutes(10);
    offers.state.price = 1.2;
    const second = await orderOf(await approve(app, pending));
    expect(second.status).toBe("pending_approval");
    expect(second.reasons).toEqual(expect.arrayContaining(["SPEND_OVER_LIMIT", "PRICE_CHANGED"]));

    // The re-quoted offers expire too, and the next re-quote is higher again.
    clock.now = inMinutes(21);
    offers.state.price = 1.5;
    const response = await approve(app, second);
    expect(response.status).toBe(200);
    const third = await orderOf(response);
    expect(third.status).toBe("pending_approval");
    expect(third.reasons).toContain("PRICE_CHANGED");
    expect(third.proposalVersion).toBe(second.proposalVersion + 1);
    expect(third.requotes).toHaveLength(2);
    expect(events(third)).not.toContain("approver:approved");
    expect(third.receipt).toBeUndefined();
    expect((await counts(db)).history).toBe(0);
  }));

test("a re-quote with a later delivery date stays pending with AVAILABILITY_DIFFERS even when the order was already late", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const requested = fixtures.offerClaims.requestedDate;
    const pending = await pendingOrder(app, [
      await sign({ ...overLimit, deliveryDate: day(requested, 1) }, inMinutes(10)),
    ]);
    expect(pending.reasons).toContain("AVAILABILITY_DIFFERS");
    clock.now = inMinutes(10);
    offers.state.deliveryDate = day(requested, 3);

    const order = await orderOf(await approve(app, pending));
    expect(order.status).toBe("pending_approval");
    expect(order.reasons).toContain("AVAILABILITY_DIFFERS");
    expect(order.proposalVersion).toBe(pending.proposalVersion + 1);
    expect(events(order)).not.toContain("approver:approved");
    expect((await counts(db)).history).toBe(0);
  }));

test("a re-quote at a lower price on the same terms is placed", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.price = 0.9;

    const order = await orderOf(await approve(app, pending));
    expect(order.status).toBe("placed");
    expect(order.total.gross).toBeLessThan(pending.total.gross);
    expect(order.reasons).not.toContain("PRICE_CHANGED");
  }));

const B = "prod_test_b";
const productB = { productId: B, product: { ...fixtures.offerClaims.product, name: "Test b" } };

/** The products a check_failed event names for `reason` in the order's audit. */
const flagged = (order: Order, reason: string) =>
  order.audit
    .filter((event) => event.event === "check_failed" && event.reason === reason)
    .map((event) => event.productId);

/** The order stays pending, with nothing placed and the stored order the same. */
const staysPending = async (
  db: Parameters<typeof counts>[0],
  app: AnyElysia,
  order: Order,
  pending: Order,
) => {
  expect(order.status).toBe("pending_approval");
  expect(order.proposalVersion).toBe(pending.proposalVersion + 1);
  expect(events(order)).not.toContain("approver:approved");
  const stored = await orderOf(await call(app, "GET", `/${order.orderId}`));
  expect(stored.status).toBe("pending_approval");
  expect(stored.proposalVersion).toBe(order.proposalVersion);
  expect((await counts(db)).history).toBe(0);
};

/** The order is untouched: same proposal, nothing re-quoted, nothing placed. */
const unchanged = async (db: Parameters<typeof counts>[0], app: AnyElysia, pending: Order) => {
  const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
  expect(stored.status).toBe("pending_approval");
  expect(stored.proposalVersion).toBe(pending.proposalVersion);
  expect(stored.requotes).toEqual(pending.requotes);
  expect(stored.audit).toHaveLength(pending.audit.length);
  expect((await counts(db)).history).toBe(0);
};

test("a re-quote where one line got dearer and another cheaper stays pending even though the total fell", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [
      await sign(overLimit, inMinutes(10)),
      await sign(productB, inMinutes(10)),
    ]);
    clock.now = inMinutes(10);
    offers.state.priceOf.set(fixtures.offerClaims.productId, 0.9);
    offers.state.priceOf.set(B, 1.2);

    const order = await orderOf(await approve(app, pending));
    expect(order.total.gross).toBeLessThan(pending.total.gross);
    await staysPending(db, app, order, pending);
    expect(flagged(order, "PRICE_CHANGED")).toEqual([B]);
  }));

test("a re-quote with a smaller pack at the same price stays pending with PRICE_CHANGED", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.tweak = (claims) => ({
      ...claims,
      product: { ...claims.product, perSalesUnit: { value: 6, unit: "LTR" } },
    });

    const order = await orderOf(await approve(app, pending));
    await staysPending(db, app, order, pending);
    expect(flagged(order, "PRICE_CHANGED")).toEqual([fixtures.offerClaims.productId]);
  }));

test("a re-quote whose price incl. VAT rose on one line stays pending, though its net price did not", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [
      await sign(overLimit, inMinutes(10)),
      await sign(productB, inMinutes(10)),
    ]);
    clock.now = inMinutes(10);
    offers.state.priceOf.set(fixtures.offerClaims.productId, 0.9);
    offers.state.tweak = (claims) =>
      claims.productId === B
        ? { ...claims, total: { ...claims.total, gross: claims.total.gross + 5 } }
        : claims;

    const order = await orderOf(await approve(app, pending));
    expect(order.total.gross).toBeLessThan(pending.total.gross);
    await staysPending(db, app, order, pending);
    expect(flagged(order, "PRICE_CHANGED")).toEqual([B]);
  }));

test("a re-quote whose net price rose stays pending, though its price incl. VAT did not", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.tweak = (claims) => ({
      ...claims,
      unitPrice: { ...claims.unitPrice, net: claims.unitPrice.net + 1 },
    });

    const order = await orderOf(await approve(app, pending));
    await staysPending(db, app, order, pending);
    expect(flagged(order, "PRICE_CHANGED")).toEqual([fixtures.offerClaims.productId]);
  }));

test("a re-quote whose deposits became unknown stays pending with PRICE_CHANGED", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [
      await sign({ ...overLimit, deposits: 4, depositsIncluded: true }, inMinutes(10)),
    ]);
    clock.now = inMinutes(10);
    offers.state.tweak = (claims) => ({
      ...claims,
      deposits: 0,
      depositsIncluded: false,
      total: { net: claims.total.net - 4, gross: claims.total.gross - 4 },
    });

    const order = await orderOf(await approve(app, pending));
    expect(order.total.gross).toBeLessThan(pending.total.gross);
    await staysPending(db, app, order, pending);
    expect(flagged(order, "PRICE_CHANGED")).toEqual([fixtures.offerClaims.productId]);
  }));

test("a re-quote with a new shortfall stays pending even when the order was already late", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const requested = fixtures.offerClaims.requestedDate;
    const pending = await pendingOrder(app, [
      await sign({ ...overLimit, deliveryDate: day(requested, 1) }, inMinutes(10)),
    ]);
    expect(pending.reasons).toContain("AVAILABILITY_DIFFERS");
    clock.now = inMinutes(10);
    // The quantity stays, so only the new shortfall can keep it pending.
    offers.state.tweak = (claims) => ({ ...claims, shortfall: { value: 12, unit: "LTR" } });

    const order = await orderOf(await approve(app, pending));
    await staysPending(db, app, order, pending);
  }));

/** Claims of `productId` with the given delivery reliability. */
const low = (productId: string, reliability: number) => ({
  productId,
  product: { ...fixtures.offerClaims.product, name: productId, deliveryReliability: reliability },
});

test("a stricter mandate that flags another product for a reason the order already had stays pending", async () =>
  withDatabase(async (db) => {
    const { app, register, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [
      await sign({ ...low(fixtures.offerClaims.productId, 0.85) }),
      await sign(low(B, 0.92)),
    ]);
    expect(flagged(pending, "RELIABILITY_BELOW_MIN")).toEqual([fixtures.offerClaims.productId]);
    const current = await register(
      limitsWith({ minDeliveryReliability: { value: 0.95, ifNoData: "auto" } }),
    );
    offers.state.mandate = { mandateId: current.mandateId, version: current.version };

    const order = await orderOf(await approve(app, pending));
    // The reason code was on the order already, but not for B: the approver never saw it there.
    expect(order.reasons).toEqual(pending.reasons);
    await staysPending(db, app, order, pending);
    expect(flagged(order, "RELIABILITY_BELOW_MIN")).toContain(B);
  }));

test("a re-quote that the new check rejects records no approval on the rejected order", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.tweak = (claims) => ({ ...claims, cutoffAt: "2026-11-16T08:05:00Z" });

    const response = await approve(app, pending);
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order.status).toBe("rejected");
    expect(order.reasons).toContain("CUTOFF_PASSED");
    expect(order.decision).toBeNull();
    expect(events(order)).not.toContain("approver:approved");
    expect((await counts(db)).history).toBe(0);
  }));

test("approving a stale proposal of an order whose offers expired gives 409 without asking offers", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.fail = true;

    const response = await approve(app, pending, pending.proposalVersion + 1);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe("CONFLICT");
    expect(offers.calls).toHaveLength(0);
    await unchanged(db, app, pending);
  }));

test("a re-quoted token that fails verification gives 502 and leaves the order as it was", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.broken = true;

    const response = await approve(app, pending);
    expect(response.status).toBe(502);
    // The fault is on the offers side: the approver is told to retry, not that their offer is bad.
    const { error } = ErrorEnvelopeSchema.parse(await response.json());
    expect(error.message).toContain("could not be re-quoted");
    await unchanged(db, app, pending);
  }));

test("a re-quote that returns an offer the order already used gives 502 and leaves the order as it was", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    offers.state.reuse = true;

    const response = await approve(app, pending);
    expect(response.status).toBe(502);
    await unchanged(db, app, pending);
  }));

test("a re-quoted token signed for another product than its line gives 502 and is not placed", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    // The response says the line's product; the token it sends is for another one.
    offers.state.signAs = (claims) => ({
      ...claims,
      productId: B,
      product: { ...claims.product, name: "Test b" },
    });

    const response = await approve(app, pending);
    expect(response.status).toBe(502);
    await unchanged(db, app, pending);
  }));

test("a re-quoted offer that expires while the approval waits for the lock is not placed", async () =>
  withDatabase(async (db) => {
    const mounted = await mountWithOffers(db);
    const { clock, sign, offers } = mounted;
    const store = postgresOrderStore(db);
    // The re-quoted offers live ten minutes; the approval's lock is granted after eleven.
    const lock = { delayed: false };
    const app = mounted.appWith({
      offers: offers.port,
      store: {
        ...store,
        withCustomerLock: (customer, work) => {
          if (lock.delayed) clock.now = inMinutes(21);
          return store.withCustomerLock(customer, work);
        },
      },
    });
    const pending = await pendingOrder(app, [await sign(overLimit, inMinutes(10))]);
    clock.now = inMinutes(10);
    lock.delayed = true;

    const response = await approve(app, pending);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe("OFFER_EXPIRED");
    await unchanged(db, app, pending);
  }));
