import { signMandate } from "@app/contract/server";
import { env } from "@app/server-kit";
import type { MandateSigner } from "../application/mandates.ts";

const generateCommand = "Create it with: bun scripts/generate-keys.ts";

// One generated key per process, so every mandate signed by this process verifies with the same key.
let processKey: Promise<JsonWebKey> | undefined;

const generateProcessKey = async (): Promise<JsonWebKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  console.error(
    `BUYER_SIGNING_JWK is not set: mandates are signed with a key made for this process, so a restart invalidates their signatures. ${generateCommand}`,
  );
  return { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), alg: "ES256" };
};

/**
 * The buyer's private signing JWK from `BUYER_SIGNING_JWK` (SPEC-008, simulated custody). Outside
 * production, a key generated for this process when it is unset. Throws when it is unset in production
 * or is not JSON; signMandate rejects a JWK that is not a private P-256 key.
 */
const buyerSigningKeyFromEnv = async (): Promise<JsonWebKey> => {
  const text = env("BUYER_SIGNING_JWK");
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The parse error is dropped on purpose: its message echoes part of the secret.
      throw new Error("BUYER_SIGNING_JWK is not valid JSON.");
    }
    if (typeof parsed !== "object" || parsed === null)
      throw new Error("BUYER_SIGNING_JWK is not a JSON object.");
    return parsed;
  }
  if (env("NODE_ENV") === "production")
    throw new Error(`BUYER_SIGNING_JWK must be set in production. ${generateCommand}`);
  processKey ??= generateProcessKey();
  return processKey;
};

/** Signs with the key that `key` resolves at sign time, so a server without a key starts and fails only on register in production. */
export const buyerSigner =
  (key: () => Promise<JsonWebKey> = buyerSigningKeyFromEnv): MandateSigner =>
  async (mandate) =>
    signMandate(mandate, await key());
