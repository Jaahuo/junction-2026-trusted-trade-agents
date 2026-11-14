import { err, ok, type Result } from "@app/kernel";
import { CompactSign } from "jose";
import { type Mandate, MandateSchema } from "../mandate.ts";
import { ALG, importSignKey, importVerifyKey, verifyTypedJws } from "./jws.ts";

const MANDATE_TYP = "mandate+jwt";

/** ES256 compact JWS, typ "mandate+jwt". The payload is the mandate exactly, so the JWS decodes to the stored mandate. */
export const signMandate = async (m: Mandate, key: JsonWebKey): Promise<string> => {
  const { privateKey } = await importSignKey(key, "The buyer signing key");
  return new CompactSign(new TextEncoder().encode(JSON.stringify(m)))
    .setProtectedHeader({ alg: ALG, typ: MANDATE_TYP })
    .sign(privateKey);
};

/**
 * Accepts the buyer's private or public JWK; only its public part is used. Checks the signature, alg, typ
 * and the mandate schema only: `exp` is not checked, so the caller decides whether the mandate is current.
 * Throws when the key is not a P-256 JWK, because the key is our configuration, not caller input.
 */
export const verifyMandate = async (
  jws: string,
  key: JsonWebKey,
): Promise<Result<Mandate, "MANDATE_INVALID">> => {
  const verifyKey = await importVerifyKey(key);
  if (verifyKey === null) throw new Error("The buyer verification key is not a P-256 JWK.");
  const mandate = await verifyTypedJws({
    token: jws,
    typ: MANDATE_TYP,
    keyFor: async () => verifyKey,
    schema: MandateSchema,
  });
  return mandate === null ? err("MANDATE_INVALID") : ok(mandate);
};
