import { expect, test } from "bun:test";
import { ErrorEnvelopeSchema, fixtures, type OfferClaims, OffersResultSchema } from "@app/contract";
import { localOfferKeys, verifyOfferToken } from "@app/contract/server";
import { fakeAvailability, fakeOffersDeps, fakePrice, fakeProduct } from "../application/fakes.ts";
import { envOfferSigner } from "../infra/offer-signer.ts";
import { createApi } from "./routes.ts";

// Invented products only (team rules R-23).
const OAT = "prod_test_oat";
const RYE = "prod_test_rye";

const mount = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const key = {
    kid: "requote-test",
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
  const fake = fakeOffersDeps({
    products: [fakeProduct(OAT), fakeProduct(RYE)],
    live: {
      [OAT]: { availability: { "*": fakeAvailability(OAT) }, prices: { "*": fakePrice(OAT) } },
      [RYE]: { availability: { "*": fakeAvailability(RYE) }, prices: { "*": fakePrice(RYE) } },
    },
  });
  const signer = envOfferSigner(async () => key);
  const deps = { ...fake.deps, signer };
  const { iat: _iat, exp: _exp, ...base } = fixtures.offerClaims;
  const offer = async (
    changes: Partial<OfferClaims> = {},
    exp = new Date("2026-11-15T10:00:00Z"),
  ) =>
    (
      await signer.sign(
        {
          ...base,
          offerId: "off_source",
          productId: OAT,
          mandateId: null,
          mandateVersion: null,
          ...changes,
        },
        exp,
      )
    ).token;
  const verify = async (token: string) =>
    verifyOfferToken(token, localOfferKeys(await signer.jwks()), fake.clock.now());
  return { app: createApi(deps), offer, verify };
};

const requote = (app: ReturnType<typeof createApi>, body: object) =>
  app.handle(
    new Request("http://localhost/offers/requote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("requote issues a new signed offer for the token's product at the changed quantity", async () => {
  const { app, offer, verify } = await mount();
  const token = await offer();
  const response = await requote(app, {
    tokens: [token],
    changes: [{ productId: OAT, quantity: { value: 2, unit: "CT" } }],
  });
  expect(response.status).toBe(200);
  const result = OffersResultSchema.parse(await response.json());
  expect(result.omitted).toEqual([]);
  expect(result.offers).toHaveLength(1);
  const [fresh] = result.offers;
  expect(fresh?.claims).toMatchObject({
    productId: OAT,
    quantity: { value: 2, unit: "CT" },
    total: { net: 20 },
    replaces: null,
  });
  expect(fresh?.offerId).not.toBe("off_source");
  expect((await verify(fresh?.token ?? "")).ok).toBe(true);
});

test("a requoted substitute still names the product it replaces", async () => {
  const { app, offer } = await mount();
  const response = await requote(app, {
    tokens: [await offer({ productId: RYE, replaces: OAT })],
  });
  const result = OffersResultSchema.parse(await response.json());
  expect(result.offers.map((line) => [line.claims.productId, line.claims.replaces])).toEqual([
    [RYE, OAT],
  ]);
});

test("an expired token is requoted for the same product and quantity", async () => {
  const { app, offer } = await mount();
  const response = await requote(app, {
    tokens: [await offer({}, new Date("2026-11-14T09:00:00Z"))],
  });
  const result = OffersResultSchema.parse(await response.json());
  expect(result.offers.map((line) => line.claims.quantity)).toEqual([
    fixtures.offerClaims.quantity,
  ]);
});

test("a quantity the product cannot be offered at is omitted with its reason", async () => {
  const { app, offer } = await mount();
  const response = await requote(app, {
    tokens: [await offer()],
    changes: [{ productId: OAT, quantity: { value: 0, unit: "CT" } }],
  });
  const result = OffersResultSchema.parse(await response.json());
  expect(result.offers).toEqual([]);
  expect(result.omitted.map((entry) => entry.reason)).toEqual(["INVALID_QUANTITY"]);
});

test("a token that fails verification, or a change for a product no token offers, gives 400", async () => {
  const { app, offer } = await mount();
  const bodies = [
    { tokens: ["a.b.c"] },
    { tokens: [await offer()], changes: [{ productId: RYE, quantity: { value: 1, unit: "CT" } }] },
    { tokens: [await offer({ customer: "cust_other" })] },
  ];
  for (const body of bodies) {
    const response = await requote(app, body);
    expect(response.status).toBe(400);
    expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe("BAD_REQUEST");
  }
});
