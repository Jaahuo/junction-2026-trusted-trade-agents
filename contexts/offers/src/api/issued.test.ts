import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, fixtures, IssuedOffersSchema, OffersResultSchema } from "@app/contract";
import type { AnyElysia } from "elysia";
import { fakeAvailability, fakeOffersDeps, fakePrice, fakeProduct } from "../application/fakes.ts";
import { createIssuedOffers } from "../application/issued-offers.ts";
import { createApi } from "./routes.ts";

// Invented products only (team rules R-23).
const OAT = "prod_test_oat";

const postJson = (app: AnyElysia, path: string, body: object) =>
  app.handle(
    new Request(`http://localhost/offers${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const setup = () => {
  const fake = fakeOffersDeps({
    products: [fakeProduct(OAT)],
    live: {
      [OAT]: { availability: { "*": fakeAvailability(OAT) }, prices: { "*": fakePrice(OAT) } },
    },
  });
  return { fake, app: createApi(fake.deps) };
};

const getOffers = async (app: AnyElysia) =>
  OffersResultSchema.parse(
    await (
      await postJson(app, "", {
        lines: [{ productId: OAT, quantity: { value: 4, unit: "CT" } }],
        deliverBy: "2026-11-20",
        paymentTerms: DEMO_ACCOUNT.paymentTerms,
        hard: [],
        soft: [],
      })
    ).json(),
  );

const issued = async (app: AnyElysia, offerIds: string[]) => {
  const response = await postJson(app, "/issued", { offerIds });
  expect(response.status).toBe(200);
  return IssuedOffersSchema.parse(await response.json()).offers;
};

test("issued returns the token get_offers signed for an offer id", async () => {
  const { app } = setup();
  const result = await getOffers(app);
  const offer = result.offers[0];
  if (offer === undefined) throw new Error("get_offers signed no offer");
  expect(await issued(app, [offer.offerId, "off_unknown"])).toEqual([
    { offerId: offer.offerId, token: offer.token },
  ]);
});

test("issued leaves out an offer once it has expired", async () => {
  const { app, fake } = setup();
  const offer = (await getOffers(app)).offers[0];
  if (offer === undefined) throw new Error("get_offers signed no offer");
  fake.clock.set(new Date((offer.claims.exp + 1) * 1000).toISOString());
  expect(await issued(app, [offer.offerId])).toEqual([]);
});

test("the store answers only the customer and agent the offer was issued to", () => {
  const store = createIssuedOffers();
  const now = new Date("2026-11-16T08:00:00Z");
  const exp = now.getTime() / 1000 + 600;
  const { customer, agentId } = DEMO_ACCOUNT;
  store.remember(
    "token-a",
    { ...fixtures.offerClaims, offerId: "off_a", customer, agentId, exp },
    now,
  );
  expect(store.find({ customer, agentId }, ["off_a"], now)).toEqual([
    { offerId: "off_a", token: "token-a" },
  ]);
  expect(store.find({ customer: "cust_other", agentId }, ["off_a"], now)).toEqual([]);
  expect(store.find({ customer, agentId: "agent_other" }, ["off_a"], now)).toEqual([]);
});

test("past its bound the store forgets the oldest offer first", () => {
  const store = createIssuedOffers(2);
  const now = new Date("2026-11-16T08:00:00Z");
  const exp = now.getTime() / 1000 + 600;
  const { customer, agentId } = DEMO_ACCOUNT;
  for (const offerId of ["off_1", "off_2", "off_3"])
    store.remember(offerId, { ...fixtures.offerClaims, offerId, customer, agentId, exp }, now);
  expect(store.find({ customer, agentId }, ["off_1", "off_2", "off_3"], now)).toEqual([
    { offerId: "off_2", token: "off_2" },
    { offerId: "off_3", token: "off_3" },
  ]);
});

test("issued refuses an empty id list", async () => {
  const { app } = setup();
  expect((await postJson(app, "/issued", { offerIds: [] })).status).toBe(400);
});
