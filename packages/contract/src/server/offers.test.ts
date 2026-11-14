import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { err, ok } from "@app/kernel";
import { SignJWT } from "jose";
import { fixtures, type OfferClaims } from "../index.ts";
import {
  localOfferKeys,
  type OfferSigningKey,
  offerSigningKeyFromEnv,
  remoteOfferKeys,
  signOfferToken,
  verifyOfferToken,
} from "./offer-token.ts";

const { iat: _iat, exp: _exp, ...unsigned } = fixtures.offerClaims;

const newKey = async (kid: string): Promise<OfferSigningKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = { ...jwk, kid, alg: "ES256" };
  return { kid, privateKey: pair.privateKey, publicJwk };
};

const inOneHour = (from: Date) => new Date(from.getTime() + 3_600_000);
const seconds = (at: Date) => Math.floor(at.getTime() / 1000);

// Longer than the remote key set's refetch cooldown.
const pastCooldown = 31_000;
const advanceClock = (ms: number) => setSystemTime(new Date(Date.now() + ms));

const loggedErrors = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

test("verifyOfferToken accepts a signOfferToken token, rejects another key, a malformed token and alg HS256 as OFFER_INVALID, returns OFFER_EXPIRED with claims after exp, and ignores a different iss host", async () => {
  const key = await newKey("offer-k1");
  const keys = localOfferKeys({ keys: [key.publicJwk] });
  const now = new Date();
  const exp = inOneHour(now);
  const claims = { ...unsigned, iss: "https://old-tunnel.example.test" };

  const token = await signOfferToken(claims, key, exp);
  const verified = await verifyOfferToken(token, keys, now);
  expect(verified).toEqual(ok({ ...claims, iat: expect.any(Number), exp: seconds(exp) }));

  // Same kid, other key material: the signature check fails.
  const impostor = await newKey("offer-k1");
  const forged = await signOfferToken(claims, impostor, exp);
  expect(await verifyOfferToken(forged, keys, now)).toEqual(err({ code: "OFFER_INVALID" }));

  for (const malformed of ["", "not-a-token", "a.b.c", `${token}x`])
    expect(await verifyOfferToken(malformed, keys, now)).toEqual(err({ code: "OFFER_INVALID" }));

  const hs256 = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256", kid: key.kid, typ: "offer+jwt" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode("a-shared-secret-of-at-least-32-bytes!"));
  expect(await verifyOfferToken(hs256, keys, now)).toEqual(err({ code: "OFFER_INVALID" }));

  const plainJwt = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key.privateKey);
  expect(await verifyOfferToken(plainJwt, keys, now)).toEqual(err({ code: "OFFER_INVALID" }));

  const { product: _product, ...incomplete } = claims;
  const notAnOffer = await new SignJWT({ ...incomplete })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "offer+jwt" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key.privateKey);
  const schemaErrors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(await verifyOfferToken(notAnOffer, keys, now)).toEqual(err({ code: "OFFER_INVALID" }));
    // A good signature over a bad payload is our own signer's bug, so it is logged, unlike a forgery.
    expect(loggedErrors(schemaErrors)).toContain("product");
  } finally {
    schemaErrors.mockRestore();
  }

  const expiredResult = await verifyOfferToken(token, keys, exp);
  expect(expiredResult).toEqual(
    err({
      code: "OFFER_EXPIRED",
      claims: { ...claims, iat: expect.any(Number), exp: seconds(exp) },
    }),
  );
});

test("localOfferKeys resolves by kid; remoteOfferKeys refetches once on an unknown kid", async () => {
  const first = await newKey("offer-a");
  const second = await newKey("offer-b");
  const local = localOfferKeys({ keys: [first.publicJwk, second.publicJwk] });
  const exp = inOneHour(new Date());
  const tokenA = await signOfferToken(unsigned, first, exp);
  const tokenB = await signOfferToken(unsigned, second, exp);
  expect((await verifyOfferToken(tokenA, local)).ok).toBe(true);
  expect((await verifyOfferToken(tokenB, local)).ok).toBe(true);
  expect(await local("offer-unknown")).toBeNull();

  let published: JsonWebKey[] = [first.publicJwk];
  let fetches = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      fetches += 1;
      return Response.json({ keys: published });
    },
  });
  try {
    const remote = remoteOfferKeys(new URL("/.well-known/jwks.json", server.url));
    expect((await verifyOfferToken(tokenA, remote)).ok).toBe(true);
    expect((await verifyOfferToken(tokenA, remote)).ok).toBe(true);
    expect(fetches).toBe(1);

    advanceClock(pastCooldown);
    expect(await remote("offer-unknown")).toBeNull();
    expect(fetches).toBe(2);

    // A rotated key appears after the cache was filled.
    published = [first.publicJwk, second.publicJwk];
    advanceClock(pastCooldown);
    expect((await verifyOfferToken(tokenB, remote)).ok).toBe(true);
    expect(fetches).toBe(3);
    expect((await verifyOfferToken(tokenB, remote)).ok).toBe(true);
    expect(fetches).toBe(3);
  } finally {
    setSystemTime();
    await server.stop(true);
  }
});

test("remoteOfferKeys refetches at most once per cooldown and keeps its keys when a fetch fails or has no usable key", async () => {
  const first = await newKey("offer-a");
  const second = await newKey("offer-b");
  const exp = inOneHour(new Date());
  const tokenA = await signOfferToken(unsigned, first, exp);
  const tokenB = await signOfferToken(unsigned, second, exp);

  let answer = () => Response.json({ keys: [first.publicJwk] });
  let fetches = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      fetches += 1;
      return answer();
    },
  });
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const remote = remoteOfferKeys(new URL("/.well-known/jwks.json", server.url));
    expect((await verifyOfferToken(tokenA, remote)).ok).toBe(true);
    expect(fetches).toBe(1);

    // Tokens with made-up kids inside the cooldown cause no fetch.
    expect(await remote("junk-1")).toBeNull();
    expect(await remote("junk-2")).toBeNull();
    expect(fetches).toBe(1);

    answer = () => new Response("down", { status: 503 });
    advanceClock(pastCooldown);
    expect(await remote("junk-3")).toBeNull();
    expect(fetches).toBe(2);
    expect((await verifyOfferToken(tokenA, remote)).ok).toBe(true);

    answer = () =>
      Response.json({ keys: [{ kty: "RSA", kid: "offer-rsa", n: "AQAB", e: "AQAB" }] });
    advanceClock(pastCooldown);
    expect(await remote("junk-4")).toBeNull();
    expect(fetches).toBe(3);
    expect((await verifyOfferToken(tokenA, remote)).ok).toBe(true);
    expect(loggedErrors(errors)).toContain("0 of 1");

    answer = () => Response.json({ keys: [first.publicJwk, second.publicJwk] });
    advanceClock(pastCooldown);
    expect((await verifyOfferToken(tokenB, remote)).ok).toBe(true);
    expect(fetches).toBe(4);
  } finally {
    errors.mockRestore();
    setSystemTime();
    await server.stop(true);
  }
});

test("verifyOfferToken throws, not OFFER_INVALID, when the key set returns a key that cannot verify", async () => {
  const key = await newKey("offer-k1");
  const token = await signOfferToken(unsigned, key, inOneHour(new Date()));
  // A signing key in a verification key set is a programming error, not a forged token.
  expect(await rejection(verifyOfferToken(token, async () => key.privateKey))).not.toBe("resolved");
});

const envNames = ["OFFER_SIGNING_JWK", "OFFER_SIGNING_KID", "NODE_ENV"] as const;
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const setEnv = (values: Partial<Record<(typeof envNames)[number], string>>) => {
  for (const name of envNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};
afterEach(() => setEnv(savedEnv));

const rejection = async (pending: Promise<unknown>) =>
  pending.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const roundTrips = async (key: OfferSigningKey): Promise<OfferClaims> => {
  const token = await signOfferToken(unsigned, key, inOneHour(new Date()));
  const verified = await verifyOfferToken(token, localOfferKeys({ keys: [key.publicJwk] }));
  if (!verified.ok) throw new Error(`token did not verify: ${verified.error.code}`);
  return verified.value;
};

test("offerSigningKeyFromEnv reads OFFER_SIGNING_JWK and OFFER_SIGNING_KID; when unset it generates a key and warns once, and with NODE_ENV=production it throws", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  setEnv({
    OFFER_SIGNING_JWK: JSON.stringify({ ...privateJwk, kid: "offer-env", alg: "ES256" }),
    OFFER_SIGNING_KID: "offer-env",
    NODE_ENV: "production",
  });
  const fromEnv = await offerSigningKeyFromEnv();
  expect(fromEnv.kid).toBe("offer-env");
  expect(fromEnv.publicJwk).not.toHaveProperty("d");
  expect(fromEnv.publicJwk).toMatchObject({ kty: "EC", crv: "P-256", kid: "offer-env" });
  expect((await roundTrips(fromEnv)).offerId).toBe(unsigned.offerId);

  setEnv({ OFFER_SIGNING_JWK: JSON.stringify(privateJwk) });
  expect(await rejection(offerSigningKeyFromEnv())).toContain("OFFER_SIGNING_KID");

  const warn = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    setEnv({ NODE_ENV: "development" });
    const generated = await offerSigningKeyFromEnv();
    const again = await offerSigningKeyFromEnv();
    expect(again.kid).toBe(generated.kid);
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await roundTrips(generated)).offerId).toBe(unsigned.offerId);

    setEnv({ NODE_ENV: "production" });
    expect(await rejection(offerSigningKeyFromEnv())).toContain("OFFER_SIGNING_JWK");
  } finally {
    warn.mockRestore();
  }
});
