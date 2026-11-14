import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, PrecheckSchema } from "@app/contract";
import type { AnyElysia } from "elysia";
import { withDatabase } from "./test-database.ts";
import {
  call,
  counts,
  errorOf,
  inMinutes,
  mount,
  orderOf,
  overLimit,
  place,
} from "./test-support.ts";
import { postgresOrderStore } from "../infra/order-store.ts";
import { refusals } from "../infra/schema.ts";

const expectInvalid = async (response: Response) => {
  expect(response.status).toBe(400);
  expect(await errorOf(response)).toBe("OFFER_INVALID");
};

const rejectPending = (app: AnyElysia, orderId: string, proposalVersion: number) =>
  call(app, "POST", `/${orderId}/decision`, {
    proposalVersion,
    decision: "reject",
    next: "stop",
  });

for (const scenario of [
  { name: "placed", changes: {}, history: 1 },
  { name: "pending_approval", changes: overLimit, history: 0 },
] as const) {
  test(`${scenario.name} offer cannot be reused under another key`, async () =>
    withDatabase(async (db) => {
      const { app, sign } = await mount(db);
      const token = await sign(scenario.changes);
      const first = await place(app, [token]);
      expect(first.status).toBe(201);
      expect((await orderOf(first)).status).toBe(scenario.name);
      await expectInvalid(await place(app, [token]));
      expect(await counts(db)).toEqual({ orders: 1, refusals: 1, history: scenario.history });
      const rows = await db.select({ event: refusals.event }).from(refusals);
      expect(rows.map(({ event }) => [event.event, event.detail])).toEqual([
        ["order_refused", "OFFER_INVALID"],
      ]);
    }));

  test(`different-key race for a ${scenario.name} offer has one winner`, async () =>
    withDatabase(async (db) => {
      const { app, sign } = await mount(db);
      const token = await sign(scenario.changes);
      const responses = await Promise.all([place(app, [token]), place(app, [token])]);
      expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
        201, 400,
      ]);
      for (const response of responses) {
        if (response.status === 201) expect((await orderOf(response)).status).toBe(scenario.name);
        else await expectInvalid(response);
      }
      expect(await counts(db)).toEqual({ orders: 1, refusals: 1, history: scenario.history });
    }));
}

test("same-key retry returns the order and changed tokens conflict before replay checking", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const token = await sign();
    const body = { offers: [token], idempotencyKey: "replay-key" };
    const first = await call(app, "POST", "", body);
    expect(first.status).toBe(201);
    const order = await orderOf(first);
    const retry = await call(app, "POST", "", body);
    expect(retry.status).toBe(200);
    expect(await orderOf(retry)).toEqual(order);
    const conflict = await call(app, "POST", "", {
      ...body,
      offers: [token, await sign()],
    });
    expect(conflict.status).toBe(409);
    expect(await errorOf(conflict)).toBe("CONFLICT");
    expect(await counts(db)).toEqual({ orders: 1, refusals: 0, history: 1 });
  }));

test("verified offer IDs, not signed token strings, are consumed and cannot repeat in a request", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const offerId = `off_${crypto.randomUUID()}`;
    const first = await sign({ offerId });
    const second = await sign({ offerId, total: { net: 101, gross: 110 } });
    expect(first).not.toBe(second);
    await expectInvalid(await place(app, [first, second]));
    expect(await counts(db)).toEqual({ orders: 0, refusals: 1, history: 0 });
    expect((await place(app, [first])).status).toBe(201);
    await expectInvalid(await place(app, [second]));
    expect(await counts(db)).toEqual({ orders: 1, refusals: 2, history: 1 });
  }));

test("a mixed reused and fresh request is atomic and leaves the fresh offer usable", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const used = await sign();
    const fresh = await sign();
    expect((await place(app, [used])).status).toBe(201);
    await expectInvalid(await place(app, [used, fresh]));
    expect(await counts(db)).toEqual({ orders: 1, refusals: 1, history: 1 });
    expect((await place(app, [fresh])).status).toBe(201);
    expect(await counts(db)).toEqual({ orders: 2, refusals: 1, history: 2 });
  }));

test("rejected and declined orders permanently consume their selected offer IDs", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const rejectedId = `off_${crypto.randomUUID()}`;
    const expired = await sign({ offerId: rejectedId }, inMinutes(-1));
    const rejected = await place(app, [expired]);
    expect(rejected.status).toBe(201);
    expect((await orderOf(rejected)).status).toBe("rejected");
    await expectInvalid(await place(app, [await sign({ offerId: rejectedId })]));

    const pendingToken = await sign(overLimit);
    const pending = await orderOf(await place(app, [pendingToken]));
    expect(pending.status).toBe("pending_approval");
    const decision = await rejectPending(app, pending.orderId, pending.proposalVersion);
    expect(decision.status).toBe(200);
    expect((await orderOf(decision)).status).toBe("declined");
    await expectInvalid(await place(app, [pendingToken]));
    expect(await counts(db)).toEqual({ orders: 2, refusals: 2, history: 0 });
  }));

test("alternatives do not consume IDs and may reference an already consumed ID", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const primary = await sign();
    const alternative = await sign();
    const initial = await place(app, [primary], { alternatives: [alternative] });
    expect(initial.status).toBe(201);
    const next = await place(app, [alternative], { alternatives: [primary] });
    expect(next.status).toBe(201);
    expect((await orderOf(next)).alternatives.map((line) => line.token)).toEqual([primary]);
    await expectInvalid(await place(app, [alternative]));
    expect(await counts(db)).toEqual({ orders: 2, refusals: 1, history: 2 });
  }));

test("precheck is advisory even after an offer is consumed", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const token = await sign();
    expect((await place(app, [token])).status).toBe(201);
    const before = await counts(db);
    const response = await call(app, "POST", "/precheck", { offers: [token] });
    expect(response.status).toBe(200);
    expect(PrecheckSchema.parse(await response.json()).decision).toBe("auto");
    expect(await counts(db)).toEqual(before);
    await expectInvalid(await place(app, [token]));
    expect(await counts(db)).toEqual({ orders: 1, refusals: 1, history: 1 });
  }));

test("the store finds existing selected lines by customer without a consumption backfill", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const offerId = `off_${crypto.randomUUID()}`;
    const alternativeId = `off_${crypto.randomUUID()}`;
    const response = await place(app, [await sign({ offerId })], {
      alternatives: [await sign({ offerId: alternativeId })],
    });
    expect(response.status).toBe(201);
    const store = postgresOrderStore(db);
    const customer = DEMO_ACCOUNT.customer;
    await store.withCustomerLock(customer, async (tx) => {
      expect(await tx.hasUsedOffers(customer, [offerId])).toBe(true);
      expect(await tx.hasUsedOffers(customer, [alternativeId])).toBe(false);
      expect(await tx.hasUsedOffers(customer, [])).toBe(false);
      expect(await tx.hasUsedOffers("another-customer", [offerId])).toBe(false);
    });
  }));
