import { expect, test } from "bun:test";
import { DEMO_ACCOUNT } from "@app/contract";
import type { Db } from "@app/server-kit";
import { commitPlacement } from "../application/commit-placement.ts";
import type { OrderStore } from "../application/ports.ts";
import { postgresOrderStore } from "../infra/order-store.ts";
import { refusingPayment } from "../infra/payment/refusing-payment.ts";
import {
  call,
  counts,
  errorOf,
  inMinutes,
  limitsWith,
  mount,
  orderOf,
  overLimit,
  place,
} from "./test-support.ts";
import { withDatabase } from "./test-database.ts";

const withOrders = (run: (db: Db, mounted: Awaited<ReturnType<typeof mount>>) => Promise<void>) =>
  withDatabase(async (db) => run(db, await mount(db)));

test("an offer with payment terms other than the account's gives 400 BAD_REQUEST and one refusal record", async () => {
  await withOrders(async (db, { app, sign }) => {
    expect(DEMO_ACCOUNT.paymentTerms).toBe("invoice");
    const response = await place(app, [await sign({ paymentTerms: "pay_on_order" })]);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("BAD_REQUEST");
    expect(await counts(db)).toEqual({ orders: 0, refusals: 1, history: 0 });
  });
});

test("an alternative with other payment terms than the offers gives 400 BAD_REQUEST", async () => {
  await withOrders(async (db, { app, sign }) => {
    const response = await place(app, [await sign()], {
      alternatives: [await sign({ paymentTerms: "pay_on_order" })],
    });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("BAD_REQUEST");
    expect(await counts(db)).toEqual({ orders: 0, refusals: 1, history: 0 });
  });
});

test("a current mandate of another agent or customer counts as no mandate: rejected MANDATE_INVALID", async () => {
  await withOrders(async (db, { appWith, mandate, sign }) => {
    for (const other of [{ agent: "agent_other" }, { iss: "cust_other" }]) {
      const app = appWith({
        mandates: { current: async () => ({ ok: true, value: { ...mandate, ...other } }) },
      });
      const response = await place(app, [await sign()]);
      expect(response.status).toBe(201);
      const order = await orderOf(response);
      expect(order.status).toBe("rejected");
      expect(order.reasons).toEqual(["MANDATE_INVALID"]);
    }
    expect(await counts(db)).toEqual({ orders: 2, refusals: 0, history: 0 });
  });
});

test("two parallel automatic orders that together exceed the credit limit: one placed, one rejected CREDIT_LIMIT", async () => {
  await withOrders(async (db, { app, register, sign }) => {
    const mandate = await register(
      limitsWith({ maxOrderTotal: { value: 10_000, currency: "EUR", basis: "gross" } }),
    );
    const big = {
      total: { net: 2700, gross: 3000 },
      mandateId: mandate.mandateId,
      mandateVersion: mandate.version,
    };
    // Both tokens are signed first, so the two placements really run at the same time.
    const tokens = [await sign(big), await sign(big)];
    const responses = await Promise.all(tokens.map((token) => place(app, [token])));
    const orders = await Promise.all(responses.map(orderOf));
    expect(orders.map((order) => order.status).toSorted()).toEqual(["placed", "rejected"]);
    expect(orders.find((order) => order.status === "rejected")?.reasons).toEqual(["CREDIT_LIMIT"]);
    expect(await counts(db)).toEqual({ orders: 2, refusals: 0, history: 1 });
  });
});

test("an order sent to approval or rejected adds no history", async () => {
  await withOrders(async (db, { app, sign }) => {
    const pending = await orderOf(await place(app, [await sign(overLimit)]));
    expect(pending.status).toBe("pending_approval");
    const rejected = await orderOf(await place(app, [await sign({}, inMinutes(-1))]));
    expect(rejected.status).toBe("rejected");
    expect(await counts(db)).toEqual({ orders: 2, refusals: 0, history: 0 });
  });
});

test("each refusal of the token checks writes one refusal record; a body that fails its schema writes none", async () => {
  await withOrders(async (db, { app, sign }) => {
    const token = await sign();
    expect((await place(app, [token, token])).status).toBe(400);
    expect(await counts(db)).toEqual({ orders: 0, refusals: 1, history: 0 });
    const mixed = await place(app, [await sign(), await sign({ paymentTerms: "pay_on_order" })]);
    expect(mixed.status).toBe(400);
    expect(await counts(db)).toEqual({ orders: 0, refusals: 2, history: 0 });
    const withStatus = await place(app, [await sign()], { status: "placed" });
    expect(withStatus.status).toBe(400);
    expect(await counts(db)).toEqual({ orders: 0, refusals: 2, history: 0 });
  });
});

test("an offer issued to another customer gives 400 BAD_REQUEST and one refusal record", async () => {
  await withOrders(async (db, { app, sign }) => {
    const response = await place(app, [await sign({ customer: "cust_other" })]);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("BAD_REQUEST");
    expect(await counts(db)).toEqual({ orders: 0, refusals: 1, history: 0 });
  });
});

test("a later retry with the same key and tokens returns the stored order with 200 and adds nothing", async () => {
  await withOrders(async (db, { app, sign }) => {
    const body = { offers: [await sign()], idempotencyKey: "retry-key" };
    const first = await call(app, "POST", "", body);
    expect(first.status).toBe(201);
    const again = await call(app, "POST", "", body);
    expect(again.status).toBe(200);
    expect((await orderOf(again)).orderId).toBe((await orderOf(first)).orderId);
    expect(await counts(db)).toEqual({ orders: 1, refusals: 0, history: 1 });
  });
});

test("a failure while writing a placed order rolls back its history rows too", async () => {
  await withOrders(async (db, { appWith, sign }) => {
    const base = postgresOrderStore(db);
    const failingInsert: OrderStore = {
      ...base,
      withCustomerLock: (customer, work) =>
        base.withCustomerLock(customer, (tx) =>
          work({
            ...tx,
            insert: async () => {
              throw new Error("The order row could not be written.");
            },
          }),
        ),
    };
    const response = await place(appWith({ store: failingInsert }), [await sign()]);
    expect(response.status).toBe(500);
    expect(await counts(db)).toEqual({ orders: 0, refusals: 0, history: 0 });
  });
});

test("a pay-on-order order that reaches placement is rejected PAYMENT_FAILED and adds no history", async () => {
  await withOrders(async (db, { app, sign }) => {
    const pending = await orderOf(await place(app, [await sign(overLimit)]));
    const store = postgresOrderStore(db);
    const stored = await store.find(DEMO_ACCOUNT.customer, pending.orderId);
    if (stored === null) throw new Error("The pending order was not stored.");
    const now = new Date("2026-11-16T08:05:00Z");
    const result = await store.withCustomerLock(DEMO_ACCOUNT.customer, (tx) =>
      commitPlacement({
        tx,
        order: { ...stored, paymentTerms: "pay_on_order" },
        creditLimit: DEMO_ACCOUNT.creditLimit,
        payment: refusingPayment,
        now,
      }),
    );
    expect(result.status).toBe("rejected");
    expect(result.reasons.at(-1)).toBe("PAYMENT_FAILED");
    expect(result.audit.slice(-2).map((event) => event.event)).toEqual([
      "payment_failed",
      "rejected",
    ]);
    expect((await counts(db)).history).toBe(0);
  });
});
