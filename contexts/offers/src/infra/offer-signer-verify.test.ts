import { expect, test } from "bun:test";
import { fixtures } from "@app/contract";
import { localOfferKeys, verifyOfferToken, type OfferSigningKey } from "@app/contract/server";
import { envOfferSigner } from "./offer-signer.ts";

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

test("a signed token verifies with the published JWKS and the returned claims equal the verified claims", async () => {
  const key = await makeKey();
  const signer = envOfferSigner(async () => key);
  const { iat: _iat, exp: _exp, ...base } = fixtures.offerClaims;
  const exp = new Date(Date.now() + 60 * 60 * 1000);
  const { token, claims } = await signer.sign(base, exp);
  const verified = await verifyOfferToken(token, localOfferKeys(await signer.jwks()));
  expect(verified.ok).toBe(true);
  if (verified.ok) expect(verified.value).toEqual(claims);
});
