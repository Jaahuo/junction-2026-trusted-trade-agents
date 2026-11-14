import { expect, test } from "bun:test";
import { err } from "@app/kernel";
import { withDatabase } from "./test-database.ts";
import { counts, errorOf, mount, orderOf, place } from "./test-support.ts";

const offerId = () => `off_${crypto.randomUUID()}`;

test("place_order with an offer id from the same session's get_offers places the order", async () =>
  withDatabase(async (db) => {
    const { app, issued, sign } = await mount(db);
    const id = offerId();
    const token = await sign({ offerId: id });
    issued.set(id, token);
    const response = await place(app, [id]);
    expect(response.status).toBe(201);
    const order = await orderOf(response);
    expect(order.status).toBe("placed");
    expect(order.offerIds).toEqual([id]);
    expect(order.lines[0]?.token).toBe(token);
  }));

test("an offer id and a token mix in one order, and an id names an alternative", async () =>
  withDatabase(async (db) => {
    const { app, issued, sign } = await mount(db);
    const [first, alternative] = [offerId(), offerId()];
    issued.set(first, await sign({ offerId: first }));
    issued.set(alternative, await sign({ offerId: alternative, productId: "prod_alt" }));
    const second = await sign({ productId: "prod_second" });
    const response = await place(app, [first, second], { alternatives: [alternative] });
    expect(response.status).toBe(201);
    const order = await orderOf(response);
    expect(order.lines.map((line) => line.offerId)[0]).toBe(first);
    expect(order.alternatives.map((line) => line.offerId)).toEqual([alternative]);
  }));

test("a retry with the same key and the same ids returns the stored order", async () =>
  withDatabase(async (db) => {
    const { app, issued, sign } = await mount(db);
    const id = offerId();
    issued.set(id, await sign({ offerId: id }));
    const idempotencyKey = crypto.randomUUID();
    const first = await place(app, [id], { idempotencyKey });
    expect(first.status).toBe(201);
    // Even after the offers service forgets the id (a restart or expiry), the replay matches.
    issued.clear();
    const replay = await place(app, [id], { idempotencyKey });
    expect(replay.status).toBe(200);
    expect((await orderOf(replay)).orderId).toBe((await orderOf(first)).orderId);
  }));

test("an unknown, expired or other customer's offer id is refused with OFFER_INVALID", async () =>
  withDatabase(async (db) => {
    // The offers service answers only unexpired offers issued to the principal, so all three
    // cases reach orders as an id with no token.
    const { app } = await mount(db);
    const response = await place(app, [offerId()]);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("OFFER_INVALID");
    expect(await counts(db)).toEqual({ orders: 0, refusals: 1, history: 0 });
  }));

for (const [owner, changes] of [
  ["customer", { customer: "cust_other" }],
  ["agent", { agentId: "agent_other" }],
] as const) {
  test(`an offer id whose token names another ${owner} is refused with OFFER_INVALID`, async () =>
    withDatabase(async (db) => {
      // The lookup is an internal call without the caller, so orders checks the owner itself.
      const { app, issued, sign } = await mount(db);
      const id = offerId();
      issued.set(id, await sign({ offerId: id, ...changes }));
      const response = await place(app, [id]);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("OFFER_INVALID");
      expect(await counts(db)).toEqual({ orders: 0, refusals: 1, history: 0 });
    }));
}

test("an offer id and its own token in one request repeat the offer", async () =>
  withDatabase(async (db) => {
    const { app, issued, sign } = await mount(db);
    const id = offerId();
    const token = await sign({ offerId: id });
    issued.set(id, token);
    const response = await place(app, [id, token]);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("OFFER_INVALID");
  }));

test("more than 20 alternatives is a bad request, not an upstream failure", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const alternatives = Array.from({ length: 21 }, offerId);
    const response = await place(app, [await sign()], { alternatives });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("BAD_REQUEST");
  }));

test("a full token still works", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const response = await place(app, [await sign()]);
    expect(response.status).toBe(201);
    expect((await orderOf(response)).status).toBe("placed");
  }));

test("an unreachable offers service gives UPSTREAM_FAILED and stores nothing", async () =>
  withDatabase(async (db) => {
    const { appWith } = await mount(db);
    const app = appWith({ issuedOffers: { issued: async () => err("UPSTREAM_FAILED") } });
    const response = await place(app, [offerId()]);
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe("UPSTREAM_FAILED");
    expect(await counts(db)).toEqual({ orders: 0, refusals: 0, history: 0 });
  }));
