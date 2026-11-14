import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, fixtures, type Order, PendingListSchema } from "@app/contract";
import type { Db } from "@app/server-kit";
import type { AnyElysia } from "elysia";
import { mandateClient } from "../infra/mandate-client.ts";
import { withDatabase } from "./test-database.ts";
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

const decide = (app: AnyElysia, order: Order, body: object) =>
  call(app, "POST", `/${order.orderId}/decision`, {
    proposalVersion: order.proposalVersion,
    ...body,
  });

const events = (order: Order) => order.audit.map((event) => [event.actor, event.event]);

/** A pending order over the spend limit: scenario 2 before the approver acts. */
const pendingOrder = async (app: AnyElysia, token: Promise<string>) => {
  const order = await orderOf(await place(app, [await token]));
  expect(order.status).toBe("pending_approval");
  return order;
};

const highCo2 = { product: { ...fixtures.offerClaims.product, co2PerKg: 99 } };
const big = { total: { net: 2700, gross: 3000 } };

/** A mandate that allows 3000 EUR orders, so only the CO2 limit sends an order to approval. */
const mountWithHighSpend = async (db: Db) => {
  const mounted = await mount(db);
  const mandate = await mounted.register(
    limitsWith({ maxOrderTotal: { value: 10_000, currency: "EUR", basis: "gross" } }),
  );
  const sign = (changes: object = {}, exp = inMinutes(10)) =>
    mounted.sign(
      { mandateId: mandate.mandateId, mandateVersion: mandate.version, ...changes },
      exp,
    );
  return { ...mounted, mandate, sign };
};

test("GET /api/orders/pending lists only pending orders", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const pending = await pendingOrder(app, sign(overLimit));
    expect((await orderOf(await place(app, [await sign()]))).status).toBe("placed");
    expect((await orderOf(await place(app, [await sign({}, inMinutes(-1))]))).status).toBe(
      "rejected",
    );

    const response = await call(app, "GET", "/pending");
    expect(response.status).toBe(200);
    const list = PendingListSchema.parse(await response.json());
    expect(list.orders.map((order) => order.orderId)).toEqual([pending.orderId]);
    expect(list.orders[0]?.approvalUrl).toContain(pending.orderId);
  }));

test("approve gives placed through commitPlacement with approved and placed events, actor approver", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const pending = await pendingOrder(app, sign(overLimit));
    const response = await decide(app, pending, { decision: "approve" });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order).toMatchObject({
      status: "placed",
      reasons: ["SPEND_OVER_LIMIT"],
      approvalUrl: null,
      decision: { action: "approve", next: null, note: null, by: DEMO_ACCOUNT.accountId },
    });
    expect(events(order).slice(-2)).toEqual([
      ["approver", "approved"],
      ["server", "placed"],
    ]);
    // commitPlacement adds the history row of a placed line.
    expect(await counts(db)).toEqual({ orders: 1, refusals: 0, history: 1 });
    expect(await orderOf(await call(app, "GET", `/${order.orderId}`))).toEqual(order);
    expect(
      PendingListSchema.parse(await (await call(app, "GET", "/pending")).json()).orders,
    ).toEqual([]);
  }));

test("reject with next stop and with next alternatives gives declined and stores decision.next and the note", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    for (const next of ["stop", "alternatives"] as const) {
      const pending = await pendingOrder(app, sign(overLimit));
      const response = await decide(app, pending, {
        decision: "reject",
        next,
        note: "Too much for one week.",
      });
      expect(response.status).toBe(200);
      const order = await orderOf(response);
      expect(order).toMatchObject({
        status: "declined",
        decision: { action: "reject", next, note: "Too much for one week." },
      });
      expect(order.audit.at(-1)).toMatchObject({
        actor: "approver",
        event: "declined",
        detail: "Too much for one week.",
      });
      expect(await orderOf(await call(app, "GET", `/${order.orderId}`))).toEqual(order);
    }
    expect((await counts(db)).history).toBe(0);
  }));

test("two parallel approves of one order: one placed, one 409", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const pending = await pendingOrder(app, sign(overLimit));
    const responses = await Promise.all([
      decide(app, pending, { decision: "approve" }),
      decide(app, pending, { decision: "approve" }),
    ]);
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict === undefined ? null : await errorOf(conflict)).toBe("CONFLICT");
    expect(await counts(db)).toEqual({ orders: 1, refusals: 0, history: 1 });
  }));

test("approve with an old proposalVersion gives 409", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const pending = await pendingOrder(app, sign(overLimit));
    const response = await decide(app, pending, {
      decision: "approve",
      proposalVersion: pending.proposalVersion + 1,
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe("CONFLICT");
    expect((await orderOf(await call(app, "GET", `/${pending.orderId}`))).status).toBe(
      "pending_approval",
    );
  }));

test("approving two orders that together exceed the credit, and approve versus an automatic order: one CREDIT_LIMIT", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithHighSpend(db);
    const first = await pendingOrder(app, sign({ ...big, ...highCo2 }));
    const second = await pendingOrder(app, sign({ ...big, ...highCo2 }));
    const approved = await Promise.all(
      [first, second].map(async (order) =>
        orderOf(await decide(app, order, { decision: "approve" })),
      ),
    );
    expect(approved.map((order) => order.status).toSorted()).toEqual(["placed", "rejected"]);
    expect(approved.find((order) => order.status === "rejected")?.reasons).toContain(
      "CREDIT_LIMIT",
    );
  }));

test("approve versus an automatic order that together exceed the credit: one CREDIT_LIMIT", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithHighSpend(db);
    const pending = await pendingOrder(app, sign({ ...big, ...highCo2 }));
    const automatic = await sign(big);
    const [approval, placement] = await Promise.all([
      decide(app, pending, { decision: "approve" }),
      place(app, [automatic]),
    ]);
    const orders = [await orderOf(approval), await orderOf(placement)];
    expect(orders.map((order) => order.status).toSorted()).toEqual(["placed", "rejected"]);
    expect(orders.find((order) => order.status === "rejected")?.reasons).toContain("CREDIT_LIMIT");
    expect((await counts(db)).history).toBe(1);
  }));

test("approve looks up the mandate by the order's agentId: none gives rejected MANDATE_INVALID", async () =>
  withDatabase(async (db) => {
    const { app, mandates, mandate, sign } = await mount(db);
    const pending = await pendingOrder(app, sign(overLimit));
    await mandates.handle(
      new Request(`http://localhost/mandates/${mandate.mandateId}/revoke`, { method: "POST" }),
    );
    const response = await decide(app, pending, { decision: "approve" });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order.status).toBe("rejected");
    expect(order.reasons).toContain("MANDATE_INVALID");
    expect(events(order).slice(-3)).toEqual([
      ["approver", "approved"],
      ["server", "check_failed"],
      ["server", "rejected"],
    ]);
    expect((await counts(db)).history).toBe(0);
  }));

test("approve_and_remember gives 501", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const pending = await pendingOrder(app, sign(overLimit));
    const response = await decide(app, pending, {
      decision: "approve_and_remember",
      maxOrderTotal: 2000,
    });
    expect(response.status).toBe(501);
    expect(await errorOf(response)).toBe("NOT_IMPLEMENTED");
    const unknown = await decide(app, pending, { decision: "approve", extra: true });
    expect(unknown.status).toBe(400);
    expect((await orderOf(await call(app, "GET", `/${pending.orderId}`))).status).toBe(
      "pending_approval",
    );
  }));

test("a decision on an unknown order gives 404", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const response = await call(app, "POST", "/ord_missing/decision", {
      proposalVersion: 1,
      decision: "approve",
    });
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toBe("NOT_FOUND");
  }));

/** A mandates client whose upstream answers like a misrouted or failing service. */
const failingMandates = (status: number, body: unknown) =>
  mandateClient("http://mandates.test/api", {
    fetcher: Object.assign(
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
        }),
      { preconnect: fetch.preconnect },
    ),
  });

test("a mandates failure gives 502 UPSTREAM_FAILED: no order, no refusal record, and approval leaves the order pending", async () =>
  withDatabase(async (db) => {
    const { app, appWith, sign } = await mount(db);
    const pending = await pendingOrder(app, sign(overLimit));
    for (const mandates of [
      failingMandates(404, "Not Found"),
      failingMandates(500, { error: "boom" }),
      failingMandates(200, { mandate: { not: "a mandate" } }),
    ]) {
      const broken = appWith({ mandates });
      const placed = await place(broken, [await sign()]);
      expect(placed.status).toBe(502);
      expect(await errorOf(placed)).toBe("UPSTREAM_FAILED");
      const approved = await decide(broken, pending, { decision: "approve" });
      expect(approved.status).toBe(502);
      expect(await errorOf(approved)).toBe("UPSTREAM_FAILED");
    }
    expect(await counts(db)).toEqual({ orders: 1, refusals: 0, history: 0 });
    expect((await orderOf(await call(app, "GET", `/${pending.orderId}`))).status).toBe(
      "pending_approval",
    );
  }));

const substitute = { replaces: "prod_test_requested" };

test("the third approval of one substitute pair offers to stop asking", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const approveOne = async () => {
      const pending = await pendingOrder(app, sign(substitute));
      expect(pending.reasons).toEqual(["SUBSTITUTION"]);
      return orderOf(await decide(app, pending, { decision: "approve" }));
    };
    expect((await approveOne()).standingOffer).toBeUndefined();
    expect((await approveOne()).standingOffer).toBeUndefined();
    const third = await approveOne();
    expect(third.status).toBe("placed");
    expect(third.standingOffer).toEqual({
      replaces: substitute.replaces,
      productId: fixtures.offerClaims.productId,
      timesApproved: 3,
    });
    // The offer is not stored: a later read does not repeat it.
    const read = await orderOf(await call(app, "GET", `/${third.orderId}`));
    expect(read.standingOffer).toBeUndefined();
  }));

test("rejected substitutes do not count, and a reject never offers", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    for (const _ of [1, 2, 3]) {
      const pending = await pendingOrder(app, sign(substitute));
      const declined = await orderOf(
        await decide(app, pending, { decision: "reject", next: "stop" }),
      );
      expect(declined.standingOffer).toBeUndefined();
    }
    const pending = await pendingOrder(app, sign(substitute));
    expect(
      (await orderOf(await decide(app, pending, { decision: "approve" }))).standingOffer,
    ).toBeUndefined();
  }));

test("an auto rule places the substitute without asking and says why in the audit", async () =>
  withDatabase(async (db) => {
    const { app, register, sign } = await mount(db);
    const mandate = await register(
      limitsWith({
        substitutionRules: [
          {
            ...substitute,
            productId: fixtures.offerClaims.productId,
            policy: "auto",
            decidedAt: "2026-11-14T10:00:00+00:00",
          },
        ],
      }),
    );
    const order = await orderOf(
      await place(app, [
        await sign({
          ...substitute,
          mandateId: mandate.mandateId,
          mandateVersion: mandate.version,
        }),
      ]),
    );
    expect(order).toMatchObject({ status: "placed", reasons: [] });
    expect(order.audit).toContainEqual(
      expect.objectContaining({
        event: "check_passed",
        productId: fixtures.offerClaims.productId,
        detail: "Substitute allowed without asking: standing approval given 2026-11-14.",
      }),
    );
  }));
