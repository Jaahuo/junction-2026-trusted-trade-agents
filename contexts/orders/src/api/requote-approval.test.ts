import { expect, test } from "bun:test";
import { fixtures, type Order } from "@app/contract";
import type { AnyElysia } from "elysia";
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
