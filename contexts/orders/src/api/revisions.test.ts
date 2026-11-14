import { expect, test } from "bun:test";
import {
  fixtures,
  type OfferClaims,
  OfferClaimsSchema,
  type Order,
  type RequoteRequest,
} from "@app/contract";
import { err, ok } from "@app/kernel";
import type { AnyElysia } from "elysia";
import type { RequotePort } from "../application/ports.ts";
import { withDatabase } from "./test-database.ts";
import { call, counts, errorOf, mount, orderOf, overLimit, place } from "./test-support.ts";

const PRODUCT = fixtures.offerClaims.productId;
const SUBSTITUTE = "prod_test_substitute";
const OTHER_SUBSTITUTE = "prod_test_other_substitute";

const claimsOf = (token: string): OfferClaims => {
  const payload = token.split(".")[1] ?? "";
  return OfferClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
};

const cents = (value: number) => Math.round(value * 100) / 100;

type Sign = (changes?: Partial<OfferClaims>) => Promise<string>;

/**
 * Stands in for the offers context's requote route: a fresh signed offer per token, with the
 * change applied and the total scaled to the new amount. `omit` leaves products out; `fail` makes
 * the call fail.
 */
const fakeOffers = (sign: Sign) => {
  const calls: RequoteRequest[] = [];
  const state = { omit: new Set<string>(), fail: false };
  const port: RequotePort = {
    requote: async (request) => {
      calls.push(request);
      if (state.fail) return err("UPSTREAM_FAILED");
      const offers = [];
      const omitted = [];
      for (const token of request.tokens) {
        const { iat: _iat, exp: _exp, offerId: _offerId, ...claims } = claimsOf(token);
        if (state.omit.has(claims.productId)) {
          omitted.push({
            productId: claims.productId,
            reason: "INSUFFICIENT_STOCK" as const,
            detail: "confirmed stock is below the requested quantity",
          });
          continue;
        }
        const change = request.changes?.find((entry) => entry.productId === claims.productId);
        const quantity = change?.quantity ?? claims.quantity;
        const ratio = quantity.value / claims.quantity.value;
        const fresh = await sign({
          ...claims,
          quantity,
          total: { net: cents(claims.total.net * ratio), gross: cents(claims.total.gross * ratio) },
        });
        const freshClaims = claimsOf(fresh);
        offers.push({
          offerId: freshClaims.offerId,
          token: fresh,
          claims: freshClaims,
          precheck: null,
          rank: null,
          comparison: null,
        });
      }
      return ok({ offers, omitted });
    },
  };
  return { port, calls, state };
};

const mountWithOffers = async (db: Parameters<typeof mount>[0]) => {
  const mounted = await mount(db);
  const offers = fakeOffers(mounted.sign);
  return { ...mounted, offers, app: mounted.appWith({ offers: offers.port }) };
};

const decide = (
  app: AnyElysia,
  order: Order,
  body: object,
  proposalVersion = order.proposalVersion,
) => call(app, "POST", `/${order.orderId}/decision`, { proposalVersion, ...body });

const amount = (value: number) => [{ productId: PRODUCT, quantity: { value, unit: "CT" } }];

const pendingOrder = async (app: AnyElysia, offers: string[], extra: object = {}) => {
  const order = await orderOf(await place(app, offers, extra));
  expect(order.status).toBe("pending_approval");
  return order;
};

const edited = (order: Order) =>
  order.audit.filter((event) => event.event === "edited").map((event) => event.detail);

test("edit with a smaller amount issues a new offer, re-checks, and places when no reason remains", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const token = await sign(overLimit);
    const pending = await pendingOrder(app, [token]);

    const response = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(offers.calls).toEqual([{ tokens: [token], changes: amount(2) }]);
    expect(order).toMatchObject({
      status: "placed",
      reasons: [],
      proposalVersion: 2,
      total: { net: 550, gross: 625 },
      approvalUrl: null,
      decision: { action: "edit", next: null },
    });
    expect(order.lines.map((line) => line.claims.quantity.value)).toEqual([2]);
    expect(order.offerIds).not.toContain(pending.offerIds[0]);
    expect(order.requotes.map((entry) => entry.previous.offerId)).toEqual(pending.offerIds);
    expect(edited(order)).toEqual([`${fixtures.offerClaims.product.name}: 4 → 2 CT`]);
    expect(order.audit.at(-1)?.event).toBe("placed");
    expect((await counts(db)).history).toBe(1);
  }));

test("edit that raises the total over the limit keeps the order pending with SPEND_OVER_LIMIT and proposalVersion + 1", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    // Under the spend limit, but the CO2 limit sends it to approval.
    const highCo2 = { product: { ...fixtures.offerClaims.product, co2PerKg: 99 } };
    const pending = await pendingOrder(app, [await sign(highCo2)]);
    expect(pending.reasons).not.toContain("SPEND_OVER_LIMIT");

    const response = await decide(app, pending, { decision: "edit", changes: amount(80) });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order.status).toBe("pending_approval");
    expect(order.reasons).toContain("SPEND_OVER_LIMIT");
    expect(order.proposalVersion).toBe(2);
    expect(order.decision).toBeNull();
    expect(order.approvalUrl).toContain(order.orderId);
    expect(order.audit.at(-1)?.event).toBe("sent_to_approval");
    expect((await counts(db)).history).toBe(0);

    // The next decision must name the new proposal.
    expect((await decide(app, order, { decision: "approve" }, 1)).status).toBe(409);
    expect((await orderOf(await decide(app, order, { decision: "approve" }))).status).toBe(
      "placed",
    );
  }));

test("pick_alternative replaces the line with the chosen offered alternative and re-checks", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const alternative = await sign({ quantity: { value: 2, unit: "CT" } });
    const pending = await pendingOrder(app, [await sign(overLimit)], {
      alternatives: [alternative],
    });
    const chosen = claimsOf(alternative).offerId;

    const response = await decide(app, pending, { decision: "pick_alternative", offerId: chosen });
    expect(response.status).toBe(200);
    const order = await orderOf(response);
    expect(order).toMatchObject({ status: "placed", reasons: [], proposalVersion: 2 });
    expect(order.offerIds).toEqual([chosen]);
    expect(order.alternatives).toEqual([]);
    expect(order.requotes.map((entry) => [entry.previous.offerId, entry.current.offerId])).toEqual([
      [...pending.offerIds, chosen],
    ]);
  }));

test("a picked substitute takes the place of the substitute line and the order is checked again", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const named = (productId: string) => ({
      productId,
      replaces: PRODUCT,
      product: { ...fixtures.offerClaims.product, name: `Test ${productId}` },
    });
    const other = await sign(named(OTHER_SUBSTITUTE));
    const pending = await pendingOrder(app, [await sign(), await sign(named(SUBSTITUTE))], {
      alternatives: [other],
    });
    expect(pending.reasons).toContain("SUBSTITUTION");

    const response = await decide(app, pending, {
      decision: "pick_alternative",
      offerId: claimsOf(other).offerId,
    });
    const order = await orderOf(response);
    expect(order.lines.map((line) => line.claims.productId)).toEqual([PRODUCT, OTHER_SUBSTITUTE]);
    // The mandate asks before substituting, so the new substitute waits for approval too.
    expect(order).toMatchObject({ status: "pending_approval", proposalVersion: 2 });
    expect(order.reasons).toContain("SUBSTITUTION");
    expect(edited(order)).toEqual([`Test ${SUBSTITUTE} → Test ${OTHER_SUBSTITUTE}: 4 CT`]);
  }));

test("an alternative that the order does not hold is refused", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const elsewhere = claimsOf(await sign()).offerId;
    for (const offerId of ["off_other", elsewhere]) {
      const response = await decide(app, pending, { decision: "pick_alternative", offerId });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("BAD_REQUEST");
    }
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored).toMatchObject({ status: "pending_approval", proposalVersion: 1 });
  }));

test("a stale proposalVersion gives 409", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    for (const body of [
      { decision: "edit", changes: amount(2) },
      { decision: "pick_alternative", offerId: "off_other" },
    ]) {
      const response = await decide(app, pending, body, 2);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe("CONFLICT");
    }
    expect(offers.calls).toEqual([]);
  }));

test("two parallel edits of one proposal: one is applied, the other gives 409", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    const responses = await Promise.all([
      decide(app, pending, { decision: "edit", changes: amount(5) }),
      decide(app, pending, { decision: "edit", changes: amount(6) }),
    ]);
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored.proposalVersion).toBe(2);
    expect(stored.requotes).toHaveLength(1);
  }));

test("an edit that cannot be re-offered, or offers that cannot be reached, leave the order as it was", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);

    offers.state.omit.add(PRODUCT);
    const omitted = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(omitted.status).toBe(409);
    expect(await errorOf(omitted)).toBe("STALE_OFFER");

    offers.state.omit.clear();
    offers.state.fail = true;
    const unreachable = await decide(app, pending, { decision: "edit", changes: amount(2) });
    expect(unreachable.status).toBe(502);
    expect(await errorOf(unreachable)).toBe("UPSTREAM_FAILED");

    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored).toMatchObject({
      status: "pending_approval",
      proposalVersion: 1,
      offerIds: pending.offerIds,
    });
  }));

test("an edit to zero or of a product the order does not hold gives 400 and asks offers for nothing", async () =>
  withDatabase(async (db) => {
    const { app, sign, offers } = await mountWithOffers(db);
    const pending = await pendingOrder(app, [await sign(overLimit)]);
    for (const changes of [
      amount(0),
      [{ productId: "prod_test_unknown", quantity: { value: 1, unit: "CT" } }],
    ]) {
      const response = await decide(app, pending, { decision: "edit", changes });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("BAD_REQUEST");
    }
    expect(offers.calls).toEqual([]);
  }));

test("the offer an edit replaced stays used: placing it again gives 400 OFFER_INVALID", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mountWithOffers(db);
    const token = await sign(overLimit);
    const pending = await pendingOrder(app, [token]);
    expect((await decide(app, pending, { decision: "edit", changes: amount(2) })).status).toBe(200);
    const replay = await place(app, [token]);
    expect(replay.status).toBe(400);
    expect(await errorOf(replay)).toBe("OFFER_INVALID");
  }));
