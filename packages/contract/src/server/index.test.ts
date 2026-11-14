import { expect, test } from "bun:test";
import { ok } from "@app/kernel";
import { DEMO_ACCOUNT, fixtures } from "../index.ts";
import {
  callRoute,
  localOfferKeys,
  offerSigningKeyFromEnv,
  principalOf,
  remoteOfferKeys,
  signMandate,
  signOfferToken,
  verifyMandate,
  verifyOfferToken,
} from "./index.ts";

test("principalOf(new Headers()) returns ok(DEMO_ACCOUNT)", async () => {
  expect(await principalOf(new Headers())).toEqual(ok(DEMO_ACCOUNT));
});

test("every other server helper throws not implemented until #12", async () => {
  const { iat: _iat, exp: _exp, ...claims } = fixtures.offerClaims;
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pending: (() => unknown)[] = [
    async () => offerSigningKeyFromEnv(),
    () => localOfferKeys({ keys: [] }),
    () => remoteOfferKeys(new URL("http://127.0.0.1:1/.well-known/jwks.json")),
    async () => signOfferToken(claims, { kid: "k", privateKey, publicJwk: {} }, new Date()),
    async () => verifyOfferToken("token", async () => null),
    async () => signMandate(fixtures.storedMandate.mandate, {}),
    async () => verifyMandate("jws", {}),
    async () => callRoute("precheck", fixtures.precheckRequest),
  ];
  for (const run of pending) {
    expect(async () => run()).toThrow("not implemented");
  }
});
