import { OfferClaimsSchema, type OfferClaims } from "@app/contract";
import { offerSigningKeyFromEnv, signOfferToken, type OfferSigningKey } from "@app/contract/server";
import type { OfferSigner, PublicJwk } from "../application/ports.ts";

const REGISTERED = new Set(["jti", "nbf", "sub", "aud"]);

export const decodeOfferClaims = (token: string): OfferClaims => {
  const part = token.split(".")[1];
  if (!part) throw new Error("offer token has no payload");
  const payload: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("offer token payload is not an object");
  }
  const rest = Object.fromEntries(Object.entries(payload).filter(([k]) => !REGISTERED.has(k)));
  return OfferClaimsSchema.parse(rest);
};

const validate = (key: OfferSigningKey): { key: OfferSigningKey; jwk: PublicJwk } => {
  const { kty, crv, x, y } = key.publicJwk;
  if (kty !== "EC" || crv !== "P-256" || !x || !y) {
    throw new Error("offer signing key must be an EC P-256 key with x and y");
  }
  return { key, jwk: { kty, crv, x, y, kid: key.kid, alg: "ES256", use: "sig" } };
};

export const envOfferSigner = (
  load: () => Promise<OfferSigningKey> = offerSigningKeyFromEnv,
): OfferSigner => {
  let loaded: Promise<{ key: OfferSigningKey; jwk: PublicJwk }> | undefined;
  const getKey = () => (loaded ??= load().then(validate));
  return {
    async sign(claims, exp) {
      const token = await signOfferToken(claims, (await getKey()).key, exp);
      return { token, claims: decodeOfferClaims(token) };
    },
    async jwks() {
      return { keys: [(await getKey()).jwk] };
    },
  };
};
