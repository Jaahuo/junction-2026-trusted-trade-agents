import { describe, expect, test } from "bun:test";
import { fixtures } from "@app/contract";
import type { OfferSigningKey } from "@app/contract/server";
import { decodeOfferClaims, envOfferSigner } from "./offer-signer.ts";

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

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = (payload: unknown) => `${b64({ alg: "ES256" })}.${b64(payload)}.sig`;

describe("offer signer", () => {
  test("parallel first calls load the key once", async () => {
    let loads = 0;
    const key = await makeKey();
    const signer = envOfferSigner(async () => {
      loads += 1;
      return key;
    });
    await Promise.all([signer.jwks(), signer.jwks(), signer.jwks()]);
    expect(loads).toBe(1);
  });

  test("jwks publishes kid and alg ES256 and no private part", async () => {
    const key = await makeKey();
    const { keys } = await envOfferSigner(async () => key).jwks();
    expect(keys).toHaveLength(1);
    const [jwk] = keys;
    expect(jwk?.kid).toBe("test-kid");
    expect(jwk?.alg).toBe("ES256");
    expect(jwk?.use).toBe("sig");
    expect(Object.keys(jwk ?? {}).toSorted()).toEqual([
      "alg",
      "crv",
      "kid",
      "kty",
      "use",
      "x",
      "y",
    ]);
    expect(jwk && "d" in jwk).toBe(false);
  });

  test("a key without y or with another curve is refused", async () => {
    const key = await makeKey();
    const { y: _y, ...noY } = key.publicJwk;
    const bad = [
      { ...key, publicJwk: noY },
      { ...key, publicJwk: { ...key.publicJwk, crv: "P-384" } },
    ];
    for (const k of bad) {
      const signer = envOfferSigner(async () => k);
      expect(await signer.jwks().catch((e: unknown) => e)).toBeInstanceOf(Error);
      expect(
        await signer.sign({ ...fixtures.offerClaims }, new Date()).catch((e: unknown) => e),
      ).toBeInstanceOf(Error);
    }
  });

  test("decodeOfferClaims accepts extra jti and nbf claims and refuses another unknown key", () => {
    const claims = { ...fixtures.offerClaims };
    expect(
      decodeOfferClaims(unsigned({ ...claims, jti: "x", nbf: 1, sub: "s", aud: "a" })),
    ).toEqual(claims);
    expect(() => decodeOfferClaims(unsigned({ ...claims, extra: 1 }))).toThrow();
  });
});
