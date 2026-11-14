import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";

function httpUrl(value: unknown, name: string): URL {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be an HTTP(S) URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
  return url;
}

async function fetchJson(url: URL, name: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name} request failed: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${name} response is not valid JSON`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonWebKeySet(value: unknown): value is JSONWebKeySet {
  return (
    isObject(value) &&
    Array.isArray(value["keys"]) &&
    value["keys"].every((key: unknown) => isObject(key) && typeof key["kty"] === "string")
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [baseUrl, token] = args;
  if (args.length !== 2 || typeof baseUrl !== "string" || typeof token !== "string") {
    throw new Error("usage: bun scripts/verify-offer.ts <base-url> <token>");
  }
  const base = httpUrl(baseUrl, "base URL");
  const discovery = await fetchJson(new URL("/.well-known/trusted-trade.json", base), "discovery");
  if (!isObject(discovery)) throw new Error("discovery must be a JSON object");
  const endpoint = discovery["endpoint"];
  if (typeof endpoint !== "string") throw new Error("discovery endpoint must be an HTTP(S) URL");
  httpUrl(endpoint, "discovery endpoint");
  const jwksUrl = httpUrl(discovery["jwksUri"], "discovery jwksUri");
  const jwks = await fetchJson(jwksUrl, "JWKS");
  if (!isJsonWebKeySet(jwks)) {
    throw new Error("JWKS must be an object with a keys array of objects");
  }
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
    algorithms: ["ES256"],
    issuer: endpoint,
    requiredClaims: ["iss", "iat", "exp"],
  });
  if (typeof protectedHeader.kid !== "string" || !protectedHeader.kid.trim()) {
    throw new Error("protected header must contain a nonempty kid");
  }
  if (protectedHeader.typ !== "offer+jwt")
    throw new Error("protected header typ must be offer+jwt");
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    throw new Error("iat must be a number");
  }
  console.log(
    JSON.stringify({ issuer: payload.iss, keyId: protectedHeader.kid, claims: payload }, null, 2),
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof errors.JWTExpired
      ? `offer token expired: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`verify-offer: ${message}`);
  process.exitCode = 1;
});
