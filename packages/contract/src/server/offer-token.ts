import { err, ok, type Result } from "@app/kernel";
import { env } from "@app/server-kit";
import { SignJWT } from "jose";
import { z } from "zod";
import { type OfferClaims, OfferClaimsSchema } from "../offers.ts";
import {
  ALG,
  ES256_PARAMS,
  EcPublicJwkSchema,
  importSignKey,
  importVerifyKey,
  verifyTypedJws,
} from "./jws.ts";

export interface OfferSigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}
export type OfferKeySet = (kid: string) => Promise<CryptoKey | null>;

const OFFER_TYP = "offer+jwt";
const JWKS_FETCH_TIMEOUT_MS = 5000;
// An unknown kid comes from the token, so anyone can send one; this bounds the refetches it causes.
const JWKS_REFETCH_COOLDOWN_MS = 30_000;

const KeyedPublicJwkSchema = EcPublicJwkSchema.extend({ kid: z.string() });
const JwksSchema = z.object({ keys: z.array(z.unknown()) });

const signingKey = (
  publicPart: z.infer<typeof EcPublicJwkSchema>,
  kid: string,
  privateKey: CryptoKey,
): OfferSigningKey => {
  const publicJwk = { ...publicPart, kid, alg: ALG, use: "sig" };
  return { kid, privateKey, publicJwk };
};

const keyFromEnv = async (jwkText: string, kid: string): Promise<OfferSigningKey> => {
  let json: unknown;
  try {
    json = JSON.parse(jwkText);
  } catch {
    // The parse error is dropped on purpose: its message echoes part of the secret.
    throw new Error("OFFER_SIGNING_JWK is not valid JSON.");
  }
  const { privateKey, publicPart } = await importSignKey(json, "OFFER_SIGNING_JWK");
  return signingKey(publicPart, kid, privateKey);
};

const generateProcessKey = async (): Promise<OfferSigningKey> => {
  const pair = await crypto.subtle.generateKey(ES256_PARAMS, false, ["sign", "verify"]);
  const publicPart = EcPublicJwkSchema.parse(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const kid = `offer-dev-${crypto.randomUUID().slice(0, 8)}`;
  console.error(
    "OFFER_SIGNING_JWK and OFFER_SIGNING_KID are not set: offers are signed with a key made for this process, so a restart invalidates them. Create keys with: bun scripts/generate-keys.ts",
  );
  return signingKey(publicPart, kid, pair.privateKey);
};

// One generated key per process, so every caller signs and verifies with the same key and the warning shows once.
let processKey: Promise<OfferSigningKey> | undefined;

/**
 * The offer signing key from `OFFER_SIGNING_JWK` and `OFFER_SIGNING_KID` (the kid comes from the variable,
 * not from the JWK). Outside production, a generated key when both are unset. Throws when only one is set,
 * when they are unset in production, or when the JWK is not a private P-256 key.
 */
export const offerSigningKeyFromEnv = async (): Promise<OfferSigningKey> => {
  const jwk = env("OFFER_SIGNING_JWK");
  const kid = env("OFFER_SIGNING_KID");
  if (jwk !== undefined && kid !== undefined) return keyFromEnv(jwk, kid);
  if (jwk !== undefined || kid !== undefined)
    throw new Error("Set both OFFER_SIGNING_JWK and OFFER_SIGNING_KID, or neither.");
  if (env("NODE_ENV") === "production")
    throw new Error(
      "OFFER_SIGNING_JWK and OFFER_SIGNING_KID must be set in production. Create them with: bun scripts/generate-keys.ts",
    );
  processKey ??= generateProcessKey();
  return processKey;
};

/** Resolves a kid against the given public keys. Entries without a kid or that are not P-256 keys are ignored. */
export const localOfferKeys = (jwks: { keys: JsonWebKey[] }): OfferKeySet => {
  const byKid = new Map<string, Promise<CryptoKey | null>>();
  for (const jwk of jwks.keys) {
    const parsed = KeyedPublicJwkSchema.safeParse(jwk);
    if (parsed.success) byKid.set(parsed.data.kid, importVerifyKey(parsed.data));
  }
  return async (kid) => (await byKid.get(kid)) ?? null;
};

const noKeys: OfferKeySet = async () => null;

const fetchKeys = async (jwksUrl: URL): Promise<OfferKeySet | null> => {
  try {
    const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      console.error(`The offer key set at ${jwksUrl.href} answered ${response.status}.`);
      return null;
    }
    const jwks = JwksSchema.safeParse(await response.json());
    if (!jwks.success) {
      console.error(`The offer key set at ${jwksUrl.href} is not a JWK set.`);
      return null;
    }
    const keys = jwks.data.keys.flatMap((key) => {
      const parsed = KeyedPublicJwkSchema.safeParse(key);
      return parsed.success ? [parsed.data] : [];
    });
    const dropped = jwks.data.keys.length - keys.length;
    if (dropped > 0)
      console.error(
        `The offer key set at ${jwksUrl.href} has ${keys.length} of ${jwks.data.keys.length} keys usable (kid and P-256 required).`,
      );
    // An answer with no usable key must not replace keys that work.
    return keys.length === 0 ? null : localOfferKeys({ keys });
  } catch (error) {
    console.error(`The offer key set at ${jwksUrl.href} could not be read: ${String(error)}`);
    return null;
  }
};

/**
 * Fetches the key set on first use and caches it. A kid missing from the cache refetches once,
 * at most once per cooldown (concurrent lookups share the fetch); inside the cooldown it resolves
 * to null without a fetch. A fetch that fails (network, timeout, non-2xx, not a JWK set) or has no
 * usable key keeps the previous cache. A kid still unknown resolves to null, which verifyOfferToken
 * reports as OFFER_INVALID.
 */
export const remoteOfferKeys = (jwksUrl: URL): OfferKeySet => {
  let cached: OfferKeySet = noKeys;
  let lastFetchAt: number | undefined;
  let refreshing: Promise<OfferKeySet> | undefined;
  const refresh = () => {
    refreshing ??= fetchKeys(jwksUrl)
      .then((fetched) => {
        if (fetched !== null) cached = fetched;
        return cached;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
  const mayRefetch = () => {
    if (refreshing !== undefined) return true;
    const now = Date.now();
    if (lastFetchAt !== undefined && now - lastFetchAt < JWKS_REFETCH_COOLDOWN_MS) return false;
    lastFetchAt = now;
    return true;
  };
  return async (kid) => {
    const known = await cached(kid);
    if (known !== null || !mayRefetch()) return known;
    return (await refresh())(kid);
  };
};

export const signOfferToken = async (
  claims: Omit<OfferClaims, "iat" | "exp">,
  key: OfferSigningKey,
  exp: Date,
): Promise<string> =>
  new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG, kid: key.kid, typ: OFFER_TYP })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key.privateKey);

/**
 * Verifies the ES256 signature with the key for the header kid, requires typ "offer+jwt", and parses the
 * payload with OfferClaimsSchema, where an unknown claim fails. A verified offer at or past `exp` is
 * OFFER_EXPIRED with its claims. `iss` is not compared with the current public URL, so a new public URL
 * keeps issued offers valid (SPEC-006).
 */
export const verifyOfferToken = async (
  token: string,
  keys: OfferKeySet,
  now: Date = new Date(),
): Promise<
  Result<OfferClaims, { code: "OFFER_INVALID" } | { code: "OFFER_EXPIRED"; claims: OfferClaims }>
> => {
  const claims = await verifyTypedJws({
    token,
    typ: OFFER_TYP,
    keyFor: async (kid) => (kid === undefined ? null : keys(kid)),
    schema: OfferClaimsSchema,
  });
  if (claims === null) return err({ code: "OFFER_INVALID" });
  return claims.exp <= Math.floor(now.getTime() / 1000)
    ? err({ code: "OFFER_EXPIRED", claims })
    : ok(claims);
};
