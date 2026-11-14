import { randomUUID } from "node:crypto";

// Prints new ES256 signing keys as .env lines (team rules R-18). Copy the output into your ignored .env.
const privateJwk = async (kid: string): Promise<JsonWebKey & { kid: string; alg: "ES256" }> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid, alg: "ES256" };
};

const offerKid = `offer-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const offerKey = await privateJwk(offerKid);
const buyerKey = await privateJwk(`buyer-${randomUUID().slice(0, 8)}`);

console.log(`OFFER_SIGNING_JWK=${JSON.stringify(offerKey)}`);
console.log(`OFFER_SIGNING_KID=${offerKid}`);
console.log(`BUYER_SIGNING_JWK=${JSON.stringify(buyerKey)}`);
