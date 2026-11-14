import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, OrderListSchema, RefusalListSchema } from "@app/contract";
import { orders, refusals } from "../infra/schema.ts";
import { withDatabase } from "./test-database.ts";
import { call, inMinutes, mount, orderOf, overLimit, place } from "./test-support.ts";
import { eq } from "drizzle-orm";

test("the order list returns placed, pending, rejected and declined orders", async () =>
  withDatabase(async (db) => {
    const { app, appWith, sign, publicBase } = await mount(db);
    const placed = await orderOf(await place(app, [await sign()]));
    const pending = await orderOf(await place(app, [await sign(overLimit)]));
    const rejected = await orderOf(await place(app, [await sign({}, inMinutes(-1))]));
    const toDecline = await orderOf(await place(app, [await sign(overLimit)]));
    const declined = await orderOf(
      await call(app, "POST", `/${toDecline.orderId}/decision`, {
        proposalVersion: toDecline.proposalVersion,
        decision: "reject",
        next: "stop",
      }),
    );
    expect([placed.status, pending.status, rejected.status, declined.status]).toEqual([
      "placed",
      "pending_approval",
      "rejected",
      "declined",
    ]);

    const [row] = await db.select().from(orders).where(eq(orders.orderId, placed.orderId));
    if (row === undefined) throw new Error("Placed order is missing.");
    await db.insert(orders).values({ ...row, orderId: "other-order", customer: "other-customer" });
    const other = appWith({
      principal: async () => ({ ...DEMO_ACCOUNT, customer: "other-customer" }),
    });
    publicBase.url = "https://current.example";
    const response = await call(app, "GET", "");
    expect(response.status).toBe(200);
    const raw = await response.json();
    const result = OrderListSchema.parse(raw);
    const expected = [placed, pending, rejected, declined]
      .map((order) =>
        Object.assign({}, order, {
          approvalUrl:
            order.status === "pending_approval"
              ? `https://current.example/approvals/${encodeURIComponent(order.orderId)}`
              : null,
        }),
      )
      .toSorted(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.orderId.localeCompare(a.orderId),
      );
    expect(result.orders).toEqual(expected);
    for (const order of raw.orders) {
      expect(order).not.toHaveProperty("idempotencyKey");
      expect(order).not.toHaveProperty("requested");
    }
    expect(
      OrderListSchema.parse(await (await call(other, "GET", "")).json()).orders.map(
        (order) => order.orderId,
      ),
    ).toEqual(["other-order"]);
  }));

test("the refusal list returns a forged-offer attempt", async () =>
  withDatabase(async (db) => {
    const { app, appWith, sign } = await mount(db);
    const other = appWith({
      principal: async () => ({ ...DEMO_ACCOUNT, customer: "other-customer" }),
    });
    const token = await sign();
    expect((await place(app, [`${token.slice(0, -4)}AAAA`])).status).toBe(400);
    expect((await place(app, ["not-a-token"])).status).toBe(400);
    const earlier = appWith({ now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect((await place(earlier, ["not-a-token"])).status).toBe(400);
    expect((await place(other, ["not-a-token"])).status).toBe(400);
    const initial = await db.select().from(refusals);
    const ownInitial = initial.filter((row) => row.customer === DEMO_ACCOUNT.customer);
    expect(ownInitial).toHaveLength(3);
    const before = await db.select().from(refusals);
    const response = await call(app, "GET", "/refusals");
    expect(response.status).toBe(200);
    const result = RefusalListSchema.parse(await response.json());
    const own = before
      .filter((row) => row.customer === DEMO_ACCOUNT.customer)
      .toSorted((a, b) => b.event.at.localeCompare(a.event.at) || b.id - a.id);
    expect(result.refusals).toEqual(
      own.map(({ id, event }) => ({ id, at: event.at, code: "OFFER_INVALID" })),
    );
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "OFFER_INVALID",
      "OFFER_INVALID",
      "OFFER_INVALID",
    ]);
    expect(
      RefusalListSchema.parse(await (await call(other, "GET", "/refusals")).json()).refusals,
    ).toHaveLength(1);
    expect(await db.select().from(refusals)).toEqual(before);
  }));
