import { expect, test } from "bun:test";
import type { Order } from "@app/contract";
import { verifyOrderIntegrity } from "@app/contract/server";
import { err } from "@app/kernel";
import type { Db } from "@app/server-kit";
import { eq } from "drizzle-orm";
import type { AnyElysia } from "elysia";
import { orders } from "../infra/schema.ts";
import { withDatabase } from "./test-database.ts";
import { call, counts, errorOf, mount, orderOf, overLimit, place } from "./test-support.ts";

const decide = (app: AnyElysia, order: Order) =>
  call(app, "POST", `/${order.orderId}/decision`, {
    proposalVersion: order.proposalVersion,
    decision: "approve",
  });

const pendingOrder = async (app: AnyElysia, token: string) => {
  const response = await place(app, [token]);
  expect(response.status).toBe(201);
  const order = await orderOf(response);
  expect(order.status).toBe("pending_approval");
  return order;
};

// Credit is derived from the gross total of placed invoice orders.
const creditUsed = async (db: Db) => {
  const [row] = await db.$client.unsafe(
    `select coalesce(sum("totalGross"), 0) as used from orders_orders where status = 'placed' and "paymentTerms" = 'invoice'`,
  );
  return Number(row?.used);
};

const expectUpstreamFailure = async (response: Response) => {
  expect(response.status).toBe(502);
  expect(await errorOf(response)).toBe("UPSTREAM_FAILED");
};

test("receipt signing failure rolls back automatic placement and retry places only once", async () =>
  withDatabase(async (db) => {
    const { app, appWith, sign, keys } = await mount(db);
    const broken = appWith({ signReceipt: async () => err("UPSTREAM_FAILED") });
    const token = await sign();
    const idempotencyKey = crypto.randomUUID();
    const before = await counts(db);
    const credit = await creditUsed(db);

    await expectUpstreamFailure(await place(broken, [token], { idempotencyKey }));
    expect(await counts(db)).toEqual(before);
    expect(await creditUsed(db)).toBe(credit);

    const response = await place(app, [token], { idempotencyKey });
    expect(response.status).toBe(201);
    const placed = await orderOf(response);
    expect(placed.status).toBe("placed");
    expect(typeof placed.receipt).toBe("string");
    expect((await verifyOrderIntegrity(placed, keys)).ok).toBe(true);
    expect(await counts(db)).toEqual({
      ...before,
      orders: before.orders + 1,
      history: before.history + 1,
    });
    expect(await creditUsed(db)).toBe(credit + placed.total.gross);
    const replay = await place(app, [token], { idempotencyKey });
    expect((await orderOf(replay)).receipt).toBe(placed.receipt);
    expect(await counts(db)).toEqual({
      ...before,
      orders: before.orders + 1,
      history: before.history + 1,
    });
  }));

test("receipt signing failure leaves approval pending and retry commits once", async () =>
  withDatabase(async (db) => {
    const { app, appWith, sign, keys } = await mount(db);
    const pending = await pendingOrder(app, await sign(overLimit));
    const broken = appWith({ signReceipt: async () => err("UPSTREAM_FAILED") });
    const before = await counts(db);
    const credit = await creditUsed(db);

    await expectUpstreamFailure(await decide(broken, pending));
    expect(await counts(db)).toEqual(before);
    expect(await creditUsed(db)).toBe(credit);
    const unchanged = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(unchanged).toEqual(pending);
    expect(unchanged.receipt).toBeUndefined();
    expect(unchanged.audit).toEqual(pending.audit);

    const response = await decide(app, pending);
    expect(response.status).toBe(200);
    const placed = await orderOf(response);
    expect(placed.status).toBe("placed");
    expect(typeof placed.receipt).toBe("string");
    expect((await verifyOrderIntegrity(placed, keys)).ok).toBe(true);
    expect(await counts(db)).toEqual({ ...before, history: before.history + 1 });
    expect(await creditUsed(db)).toBe(credit + placed.total.gross);
    const replay = await decide(app, pending);
    expect(replay.status).toBe(409);
    expect(await errorOf(replay)).toBe("CONFLICT");
    expect(await counts(db)).toEqual({ ...before, history: before.history + 1 });
  }));

test("approval refuses tampered pending audit without decision or history writes", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const pending = await pendingOrder(app, await sign(overLimit));
    const tampered = pending.audit.map((event, index) =>
      index === 0 ? { ...event, detail: "tampered" } : event,
    );
    await db.update(orders).set({ audit: tampered }).where(eq(orders.orderId, pending.orderId));
    const before = await counts(db);
    const credit = await creditUsed(db);

    await expectUpstreamFailure(await decide(app, pending));
    expect(await counts(db)).toEqual(before);
    expect(await creditUsed(db)).toBe(credit);
    const [stored] = await db.select().from(orders).where(eq(orders.orderId, pending.orderId));
    expect(stored?.status).toBe("pending_approval");
    expect(stored?.decision).toBeNull();
    expect(stored?.receipt).toBeNull();
    expect(stored?.audit).toEqual(tampered);
    expect(stored?.auditAnchor).toEqual(pending.auditAnchor);
  }));

test("approval refuses legacy unchained audit without rehashing it", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const pending = await pendingOrder(app, await sign(overLimit));
    const legacy = pending.audit.map(
      ({ hash: _hash, previousHash: _previousHash, ...event }) => event,
    );
    await db
      .update(orders)
      .set({ audit: legacy, auditAnchor: null })
      .where(eq(orders.orderId, pending.orderId));
    const before = await counts(db);
    const credit = await creditUsed(db);

    await expectUpstreamFailure(await decide(app, pending));
    expect(await counts(db)).toEqual(before);
    expect(await creditUsed(db)).toBe(credit);
    const [stored] = await db.select().from(orders).where(eq(orders.orderId, pending.orderId));
    expect(stored?.status).toBe("pending_approval");
    expect(stored?.decision).toBeNull();
    expect(stored?.receipt).toBeNull();
    expect(stored?.audit).toEqual(legacy);
    expect(stored?.auditAnchor).toBeNull();
  }));

test("concurrent approvals commit one receipt and chain and conflict on the losing decision", async () =>
  withDatabase(async (db) => {
    const { app, sign, keys } = await mount(db);
    const pending = await pendingOrder(app, await sign(overLimit));
    const before = await counts(db);
    const credit = await creditUsed(db);
    const responses = await Promise.all([decide(app, pending), decide(app, pending)]);
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const success = responses.find((response) => response.status === 200);
    const conflict = responses.find((response) => response.status === 409);
    if (success === undefined || conflict === undefined) {
      throw new Error("Expected successful and conflicting approval responses");
    }
    expect(await errorOf(conflict)).toBe("CONFLICT");
    const placed = await orderOf(success);
    expect(placed.status).toBe("placed");
    expect(typeof placed.receipt).toBe("string");
    expect((await verifyOrderIntegrity(placed, keys)).ok).toBe(true);
    expect(placed.audit.slice(0, pending.audit.length)).toEqual(pending.audit);
    expect(placed.audit.slice(-2).map((event) => event.event)).toEqual(["approved", "placed"]);
    expect(await orderOf(await call(app, "GET", `/${pending.orderId}`))).toEqual(placed);
    expect(await counts(db)).toEqual({ ...before, history: before.history + 1 });
    expect(await creditUsed(db)).toBe(credit + placed.total.gross);
  }));
