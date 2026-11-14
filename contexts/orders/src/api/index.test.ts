import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, fixtures, PrecheckSchema } from "@app/contract";
import { refusals } from "../infra/schema.ts";
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

test("an in-limit offer gives 201 placed with audit order_requested, offer_verified, check_passed, placed", async () =>
  withDatabase(async (db) => {
    const { app, mandate, sign } = await mount(db);
    const response = await place(app, [await sign()]);
    expect(response.status).toBe(201);
    const order = await orderOf(response);
    expect(order).toMatchObject({
      status: "placed",
      reasons: [],
      approvalUrl: null,
      customer: DEMO_ACCOUNT.customer,
      mandateId: mandate.mandateId,
      total: fixtures.offerClaims.total,
    });
    expect(order.audit.map((event) => event.event)).toEqual([
      "order_requested",
      "offer_verified",
      "check_passed",
      "placed",
    ]);
    expect(await counts(db)).toEqual({ orders: 1, refusals: 0, history: 1 });
  }));

for (const scenario of [
  { name: "within", unitNet: 50, total: { net: 600, gross: 684 }, status: "placed", reasons: [] },
  {
    name: "over",
    unitNet: 100,
    total: { net: 1200, gross: 1368 },
    status: "pending_approval",
    reasons: ["SPEND_OVER_LIMIT"],
  },
] as const) {
  test(`three distinct products form one order ${scenario.name} the aggregate spend limit`, async () =>
    withDatabase(async (db) => {
      const { app, sign } = await mount(db);
      const products = [
        { productId: "prod_test_oat", name: "Test oat drink", value: 2 },
        { productId: "prod_test_soy", name: "Test soy drink", value: 4 },
        { productId: "prod_test_rice", name: "Test rice drink", value: 6 },
      ];
      const tokens = await Promise.all(
        products.map(({ productId, name, value }) =>
          sign({
            productId,
            product: { ...fixtures.offerClaims.product, name },
            quantity: { value, unit: "CT" },
            unitPrice: { net: scenario.unitNet, vatRate: 14, currency: "EUR" },
            total: { net: scenario.unitNet * value, gross: (scenario.unitNet * value * 114) / 100 },
          }),
        ),
      );
      const response = await place(app, tokens);
      expect(response.status).toBe(201);
      const order = await orderOf(response);
      expect(order.status).toBe(scenario.status);
      expect(order.reasons).toEqual([...scenario.reasons]);
      expect(order.total).toEqual(scenario.total);
      expect(
        order.lines.map(({ claims }) => ({
          productId: claims.productId,
          quantity: claims.quantity,
        })),
      ).toEqual(
        products.map(({ productId, value }) => ({
          productId,
          quantity: { value, unit: "CT" },
        })),
      );
      expect(await counts(db)).toEqual({
        orders: 1,
        refusals: 0,
        history: scenario.status === "placed" ? 3 : 0,
      });
      const stored = await orderOf(await call(app, "GET", `/${order.orderId}`));
      expect(stored.lines).toEqual(order.lines);
      expect(stored.total).toEqual(scenario.total);
    }));
}

test("an over-limit offer gives pending_approval with reasons exactly [SPEND_OVER_LIMIT]; approvalUrl follows PUBLIC_BASE_URL", async () =>
  withDatabase(async (db) => {
    const { app, sign, publicBase } = await mount(db);
    publicBase.url = "https://first.example";
    const response = await place(app, [await sign(overLimit)]);
    expect(response.status).toBe(201);
    const order = await orderOf(response);
    expect(order.status).toBe("pending_approval");
    expect(order.reasons).toEqual(["SPEND_OVER_LIMIT"]);
    expect(order.approvalUrl).toBe(
      `https://first.example/approvals/${encodeURIComponent(order.orderId)}`,
    );
    expect(order.audit.map((event) => event.event)).toEqual([
      "order_requested",
      "offer_verified",
      "check_failed",
      "sent_to_approval",
    ]);

    publicBase.url = "https://second.example";
    const read = await orderOf(await call(app, "GET", `/${order.orderId}`));
    expect(read.approvalUrl).toBe(
      `https://second.example/approvals/${encodeURIComponent(order.orderId)}`,
    );
  }));

test("precheck gives the same decision and reasons as place_order would and leaves orders, credit and audit unchanged", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    for (const token of [await sign(), await sign(overLimit)]) {
      const before = await counts(db);
      const response = await call(app, "POST", "/precheck", { offers: [token] });
      expect(response.status).toBe(200);
      const precheck = PrecheckSchema.parse(await response.json());
      expect(await counts(db)).toEqual(before);

      const order = await orderOf(await place(app, [token]));
      const status = {
        auto: "placed",
        needs_approval: "pending_approval",
        rejected: "rejected",
      } as const;
      expect(order.status).toBe(status[precheck.decision]);
      expect(order.reasons).toEqual(precheck.reasons);
    }
  }));

test("precheck refuses a malformed token like place_order but writes no record", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const response = await call(app, "POST", "/precheck", { offers: ["not-a-token"] });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("OFFER_INVALID");
    expect(await counts(db)).toEqual({ orders: 0, refusals: 0, history: 0 });
  }));

test("a malformed token gives 400 OFFER_INVALID, stores no order and writes one order_refused record", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const tampered = `${(await sign()).slice(0, -4)}AAAA`;
    for (const token of ["not-a-token", tampered]) {
      const response = await place(app, [token]);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("OFFER_INVALID");
    }
    expect(await counts(db)).toEqual({ orders: 0, refusals: 2, history: 0 });
    const refused = await db.select({ event: refusals.event }).from(refusals);
    expect(refused.map(({ event }) => [event.event, event.detail])).toEqual([
      ["order_refused", "OFFER_INVALID"],
      ["order_refused", "OFFER_INVALID"],
    ]);
  }));

test("a malformed offer in a multi-line request refuses the whole order without consuming a valid offer", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const valid = await sign();
    const response = await place(app, [valid, "not-a-token"]);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("OFFER_INVALID");
    expect(await counts(db)).toEqual({ orders: 0, refusals: 1, history: 0 });

    const retry = await place(app, [valid]);
    expect(retry.status).toBe(201);
    const order = await orderOf(retry);
    expect(order.status).toBe("placed");
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]?.token).toBe(valid);
    expect(await counts(db)).toEqual({ orders: 1, refusals: 1, history: 1 });
  }));

test("a repeated token gives 400 OFFER_INVALID", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const token = await sign();
    const response = await place(app, [token, token]);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("OFFER_INVALID");
  }));

test("mixed paymentTerms gives 400 BAD_REQUEST and no order", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const response = await place(app, [await sign(), await sign({ paymentTerms: "pay_on_order" })]);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("BAD_REQUEST");
    expect((await counts(db)).orders).toBe(0);
  }));

test("a token with another agentId, mandateId or mandateVersion gives 409 STALE_OFFER and no order", async () =>
  withDatabase(async (db) => {
    const { app, mandate, sign } = await mount(db);
    const stale = [
      await sign({ agentId: "agent_other" }),
      await sign({ mandateId: "mnd_other" }),
      await sign({ mandateVersion: mandate.version + 1 }),
    ];
    for (const token of stale) {
      const response = await place(app, [token]);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe("STALE_OFFER");
    }
    expect(await counts(db)).toEqual({ orders: 0, refusals: 3, history: 0 });
  }));

test("expired gives rejected OFFER_EXPIRED; expired after cutoffAt gives CUTOFF_PASSED with nextDeliveryDate", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const expired = await orderOf(await place(app, [await sign({}, inMinutes(-1))]));
    expect(expired).toMatchObject({ status: "rejected", reasons: ["OFFER_EXPIRED"] });

    const late = await sign(
      { cutoffAt: inMinutes(-5).toISOString(), nextDeliveryDate: "2026-11-18" },
      inMinutes(-5),
    );
    const response = await place(app, [late]);
    expect(response.status).toBe(201);
    expect(await orderOf(response)).toMatchObject({
      status: "rejected",
      reasons: ["CUTOFF_PASSED"],
      nextDeliveryDate: "2026-11-18",
    });
  }));

test("no current mandate gives rejected MANDATE_INVALID", async () =>
  withDatabase(async (db) => {
    const { app, mandates, mandate, sign } = await mount(db);
    await mandates.handle(
      new Request(`http://localhost/mandates/${mandate.mandateId}/revoke`, { method: "POST" }),
    );
    const order = await orderOf(await place(app, [await sign()]));
    expect(order).toMatchObject({
      status: "rejected",
      reasons: ["MANDATE_INVALID"],
      mandateId: null,
    });
  }));

test("10 parallel calls with one idempotencyKey create one order", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const body = { offers: [await sign()], idempotencyKey: "key-parallel" };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => call(app, "POST", "", body)),
    );
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const orderIds = new Set(
      await Promise.all(responses.map(async (r) => (await orderOf(r)).orderId)),
    );
    expect(orderIds.size).toBe(1);
    expect(await counts(db)).toEqual({ orders: 1, refusals: 0, history: 1 });
  }));

test("same key with other tokens gives 409 CONFLICT", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    expect(
      (await call(app, "POST", "", { offers: [await sign()], idempotencyKey: "k" })).status,
    ).toBe(201);
    const again = await call(app, "POST", "", { offers: [await sign()], idempotencyKey: "k" });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe("CONFLICT");
  }));

test("a body with status or customer gives 400", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const token = await sign();
    for (const extra of [{ status: "placed" }, { customer: DEMO_ACCOUNT.customer }]) {
      const response = await place(app, [token], extra);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("BAD_REQUEST");
    }
    expect((await counts(db)).orders).toBe(0);
  }));

test("two parallel automatic orders that together exceed the creditLimit of 5000: one placed, one rejected CREDIT_LIMIT", async () =>
  withDatabase(async (db) => {
    const { app, register, sign } = await mount(db);
    const mandate = await register(
      limitsWith({ maxOrderTotal: { value: 10_000, currency: "EUR", basis: "gross" } }),
    );
    const big = {
      total: { net: 2700, gross: 3000 },
      mandateId: mandate.mandateId,
      mandateVersion: mandate.version,
    };
    const responses = await Promise.all([
      place(app, [await sign(big)]),
      place(app, [await sign(big)]),
    ]);
    const orders = await Promise.all(responses.map(orderOf));
    expect(orders.map((order) => order.status).toSorted()).toEqual(["placed", "rejected"]);
    const rejected = orders.find((order) => order.status === "rejected");
    expect(rejected?.reasons).toEqual(["CREDIT_LIMIT"]);
    expect(rejected?.audit.map((event) => event.event).slice(-2)).toEqual([
      "check_failed",
      "rejected",
    ]);
  }));

test("the demo account has no credit check: two orders over 5000 together are both placed", async () =>
  withDatabase(async (db) => {
    const { appWith, register, sign } = await mount(db);
    const app = appWith({ principal: async () => DEMO_ACCOUNT });
    expect(DEMO_ACCOUNT.creditLimit).toBeNull();
    const mandate = await register(
      limitsWith({ maxOrderTotal: { value: 10_000, currency: "EUR", basis: "gross" } }),
    );
    const big = {
      total: { net: 2700, gross: 3000 },
      mandateId: mandate.mandateId,
      mandateVersion: mandate.version,
    };
    const orders = await Promise.all(
      [await place(app, [await sign(big)]), await place(app, [await sign(big)])].map(orderOf),
    );
    expect(orders.map((order) => order.status)).toEqual(["placed", "placed"]);
  }));

test("an unknown order id gives 404", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const response = await call(app, "GET", "/ord_missing");
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toBe("NOT_FOUND");
  }));

test("alternatives are stored and not counted in the total", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const alternative = await sign({ total: { net: 500, gross: 560 } });
    const placed = await orderOf(await place(app, [await sign()], { alternatives: [alternative] }));
    expect(placed.alternatives.map((line) => line.token)).toEqual([alternative]);
    expect(placed.total).toEqual(fixtures.offerClaims.total);
    const read = await orderOf(await call(app, "GET", `/${placed.orderId}`));
    expect(read).toEqual(placed);
  }));

test("a check about one product names it in the audit; an order-level check names none", async () =>
  withDatabase(async (db) => {
    const { app, register, sign } = await mount(db);
    const mandate = await register(limitsWith({ newProducts: "ask" }));
    const under = { mandateId: mandate.mandateId, mandateVersion: mandate.version };
    const order = await orderOf(
      await place(app, [
        await sign({ ...under, ...overLimit, productId: "prod_new_a" }),
        await sign({ ...under, productId: "prod_new_b" }),
      ]),
    );
    expect(new Set(order.reasons)).toEqual(new Set(["NEW_PRODUCT", "SPEND_OVER_LIMIT"]));
    const failed = order.audit.filter((event) => event.event === "check_failed");
    const named = failed
      .filter((event) => event.reason === "NEW_PRODUCT")
      .map((event) => event.productId);
    expect(new Set(named)).toEqual(new Set(["prod_new_a", "prod_new_b"]));
    expect(failed.find((event) => event.reason === "SPEND_OVER_LIMIT")?.productId).toBeUndefined();
  }));
