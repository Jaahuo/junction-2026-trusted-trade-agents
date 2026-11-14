import { expect, test } from "bun:test";
import {
  DEMO_ACCOUNT,
  ErrorEnvelopeSchema,
  fixtures,
  type MandateLimits,
  type OfferClaims,
  type Order,
  OrderSchema,
  PrecheckSchema,
  StoredMandateSchema,
} from "@app/contract";
import { localOfferKeys, type OfferSigningKey, signOfferToken } from "@app/contract/server";
import { type Db, mountContext } from "@app/server-kit";
import { context as mandatesContext, createApi as createMandatesApi } from "@ctx/mandates/api";
import type { AnyElysia } from "elysia";
import { mandateClient } from "../infra/mandate-client.ts";
import { offerVerifier } from "../infra/offer-verifier.ts";
import { refusals } from "../infra/schema.ts";
import { context, createApi } from "./index.ts";
import { withDatabase } from "./test-database.ts";

const now = new Date("2026-11-16T08:00:00Z");
const inMinutes = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const testKey = async (): Promise<OfferSigningKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const kid = "offer-test";
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  return { kid, privateKey: pair.privateKey, publicJwk };
};

const limitsWith = (changes: Partial<MandateLimits> = {}): MandateLimits => ({
  ...fixtures.registerMandateRequest.limits,
  newProducts: "auto",
  ...changes,
});

/** The orders context and the real mandates context on one test database, with a test signing key. */
const mount = async (db: Db) => {
  await mountContext(db, mandatesContext);
  await mountContext(db, context);
  const mandates = createMandatesApi(db, () => now);
  const key = await testKey();
  const keys = localOfferKeys({ keys: [key.publicJwk] });
  // Stands in for PUBLIC_BASE_URL, which the server reads on every response.
  const publicBase = { url: "https://orders.test" };
  const app = createApi(db, {
    verifyOffer: offerVerifier(async () => keys),
    mandates: mandateClient(mandates),
    now: () => now,
    publicBaseUrl: () => publicBase.url,
  });
  const register = async (limits: MandateLimits = limitsWith()) => {
    const response = await mandates.handle(
      new Request("http://localhost/mandates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limits, standingConstraints: { hard: [], soft: [] } }),
      }),
    );
    return StoredMandateSchema.parse(await response.json()).mandate;
  };
  const mandate = await register();
  const sign = (changes: Partial<OfferClaims> = {}, exp = inMinutes(10)) => {
    const { iat: _iat, exp: _exp, ...claims } = fixtures.offerClaims;
    return signOfferToken(
      {
        ...claims,
        offerId: `off_${crypto.randomUUID()}`,
        mandateId: mandate.mandateId,
        mandateVersion: mandate.version,
        ...changes,
      },
      key,
      exp,
    );
  };
  return { app, mandates, mandate, register, sign, publicBase };
};

const call = (app: AnyElysia, method: string, path: string, body?: object) =>
  app.handle(
    new Request(`http://localhost/orders${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );

const place = (app: AnyElysia, offers: string[], extra: object = {}) =>
  call(app, "POST", "", { offers, idempotencyKey: crypto.randomUUID(), ...extra });

const orderOf = async (response: Response): Promise<Order> =>
  OrderSchema.parse(await response.json());

const errorOf = async (response: Response) =>
  ErrorEnvelopeSchema.parse(await response.json()).error.code;

const count = async (db: Db, table: string): Promise<number> => {
  const [row] = await db.$client.unsafe(`select count(*)::int as n from ${table}`);
  return Number(row?.n);
};

const counts = async (db: Db) => ({
  orders: await count(db, "orders_orders"),
  refusals: await count(db, "orders_refusals"),
  history: await count(db, "orders_history"),
});

const overLimit = { total: { net: 1100, gross: 1250 } };

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

test("an over-limit offer gives pending_approval with reasons exactly [SPEND_OVER_LIMIT]; approvalUrl follows PUBLIC_BASE_URL", async () =>
  withDatabase(async (db) => {
    const { app, sign, publicBase } = await mount(db);
    publicBase.url = "https://first.example";
    const response = await place(app, [await sign(overLimit)]);
    expect(response.status).toBe(201);
    const order = await orderOf(response);
    expect(order.status).toBe("pending_approval");
    expect(order.reasons).toEqual(["SPEND_OVER_LIMIT"]);
    expect(order.approvalUrl).toBe(`https://first.example/approvals?order=${order.orderId}`);
    expect(order.audit.map((event) => event.event)).toEqual([
      "order_requested",
      "offer_verified",
      "check_failed",
      "sent_to_approval",
    ]);

    publicBase.url = "https://second.example";
    const read = await orderOf(await call(app, "GET", `/${order.orderId}`));
    expect(read.approvalUrl).toBe(`https://second.example/approvals?order=${order.orderId}`);
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
