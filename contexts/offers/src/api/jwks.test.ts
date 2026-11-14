import { expect, test } from "bun:test";
import {
  DEMO_ACCOUNT,
  fixtures,
  type HardConstraint,
  type Mandate,
  OffersResultSchema,
} from "@app/contract";
import { localOfferKeys, type OfferSigningKey, verifyOfferToken } from "@app/contract/server";
import { fakeAvailability, fakeOffersDeps, fakePrice, fakeProduct } from "../application/fakes.ts";
import { mergeConstraints } from "../domain/offer-rules.ts";
import { envOfferSigner } from "../infra/offer-signer.ts";
import { createApi, createRoot } from "./routes.ts";

// Invented products only (team rules R-23). Runs green only after #12 builds the token helpers.
const OAT = "prod_test_oat";
const lactose: HardConstraint = { attribute: "lactose", is: "free_from" };
const mandate: Mandate = {
  ...fixtures.storedMandate.mandate,
  standingConstraints: { hard: [], soft: [{ attribute: "origin", prefer: "fi" }] },
};

const makeKey = async (): Promise<OfferSigningKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    kid: "test-kid",
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
};

test("the token verifies with GET /.well-known/jwks.json and carries customer, agentId, mandateId, mandateVersion and the merged constraints", async () => {
  const key = await makeKey();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const fake = fakeOffersDeps({
    now,
    mandate,
    products: [fakeProduct(OAT, { match: { lactose: "confirmed" } })],
    live: {
      [OAT]: {
        availability: { "*": fakeAvailability(OAT, { cutoffAt: later }) },
        prices: { "*": fakePrice(OAT, { validTo: later }) },
      },
    },
  });
  const deps = { ...fake.deps, signer: envOfferSigner(async () => key) };
  const request = {
    lines: [{ productId: OAT, quantity: { value: 4, unit: "CT" } }],
    deliverBy: "2026-11-20",
    paymentTerms: DEMO_ACCOUNT.paymentTerms,
    hard: [lactose],
    soft: [],
  };

  const response = await createApi(deps).handle(
    new Request("http://localhost/offers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  if (response.status !== 200) {
    throw new Error(`POST /offers answered ${response.status}: ${await response.text()}`);
  }
  const [offer] = OffersResultSchema.parse(await response.json()).offers;
  if (offer === undefined) throw new Error("POST /offers returned no offer");

  const jwks = await createRoot(deps).handle(new Request("http://localhost/.well-known/jwks.json"));
  const keys: { keys: JsonWebKey[] } = await jwks.json();
  const verified = await verifyOfferToken(offer.token, localOfferKeys(keys));
  if (!verified.ok) throw new Error(`the token did not verify: ${verified.error.code}`);

  expect(verified.value).toEqual(offer.claims);
  expect(verified.value).toMatchObject({
    customer: DEMO_ACCOUNT.customer,
    agentId: DEMO_ACCOUNT.agentId,
    mandateId: mandate.mandateId,
    mandateVersion: mandate.version,
    constraints: mergeConstraints({ hard: [lactose], soft: [] }, mandate.standingConstraints),
  });
  expect(verified.value.constraints.soft).toEqual(mandate.standingConstraints.soft);
});
