import { compactVerify, decodeProtectedHeader, errors, type ProtectedHeaderParameters } from "jose";
import { z } from "zod";

/** The only signing algorithm of offers and mandates (SPEC-006, SPEC-008). */
export const ALG = "ES256";
export const ES256_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The public part of a P-256 JWK. Parsing strips every other member, including a private `d`. */
export const EcPublicJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string(),
  y: z.string(),
});

const EcPrivateJwkSchema = EcPublicJwkSchema.extend({ d: z.string() });

/** Imports the public part of a JWK as an ES256 verification key; null when it is not one. */
export const importVerifyKey = async (jwk: unknown): Promise<CryptoKey | null> => {
  const parsed = EcPublicJwkSchema.safeParse(jwk);
  if (!parsed.success) return null;
  try {
    return await crypto.subtle.importKey("jwk", parsed.data, ES256_PARAMS, false, ["verify"]);
  } catch {
    return null;
  }
};

/**
 * Imports a private P-256 JWK as an ES256 signing key. `name` says which configured key it is.
 * Throws for anything else, because a signing key is our own configuration. The messages carry no key material.
 */
export const importSignKey = async (
  jwk: unknown,
  name: string,
): Promise<{ privateKey: CryptoKey; publicPart: z.infer<typeof EcPublicJwkSchema> }> => {
  const parsed = EcPrivateJwkSchema.safeParse(jwk);
  if (!parsed.success) throw new Error(`${name} is not a private ES256 (P-256) JWK.`);
  const { d: _d, ...publicPart } = parsed.data;
  try {
    const privateKey = await crypto.subtle.importKey("jwk", parsed.data, ES256_PARAMS, false, [
      "sign",
    ]);
    return { privateKey, publicPart };
  } catch (cause) {
    throw new Error(`${name} could not be imported: x and y must be the public point of d.`, {
      cause,
    });
  }
};

/**
 * Verifies a compact ES256 JWS whose header `typ` is `typ`, and parses its payload with `schema`.
 * Null for a malformed token, another algorithm or typ, no key for the header kid, a bad signature,
 * or a payload that fails the schema. A payload that fails after a good signature was made by our
 * own signer, so it is logged (issue paths only, no values). Errors that are not JOSE errors, such as
 * a key that cannot verify, are bugs and propagate. `keyFor` must not throw.
 */
export const verifyTypedJws = async <T>({
  token,
  typ,
  keyFor,
  schema,
}: {
  token: string;
  typ: string;
  keyFor: (kid: string | undefined) => Promise<CryptoKey | null>;
  schema: z.ZodType<T>;
}): Promise<T | null> => {
  let header: ProtectedHeaderParameters;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== ALG || header.typ !== typ) return null;
  const key = await keyFor(header.kid);
  if (key === null) return null;

  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(token, key, { algorithms: [ALG] }));
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    console.error(
      `A ${typ} with kid ${header.kid ?? "(none)"} is signed but its payload is not JSON.`,
    );
    return null;
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const paths = parsed.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"} ${issue.code}`,
  );
  console.error(
    `A ${typ} with kid ${header.kid ?? "(none)"} is signed but fails its schema: ${paths.join(", ")}.`,
  );
  return null;
};
