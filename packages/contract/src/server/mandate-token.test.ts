import { expect, test } from "bun:test";
import { err, ok } from "@app/kernel";
import { decodeProtectedHeader } from "jose";
import { fixtures } from "../index.ts";
import { signMandate, verifyMandate } from "./mandate-token.ts";

const buyerJwk = async (): Promise<JsonWebKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), alg: "ES256" };
};

const base64url = (text: string) => Buffer.from(text).toString("base64url");

const failure = async (pending: Promise<unknown>) =>
  pending.then(
    () => "resolved",
    (error: unknown) => String(error),
  );

test("verifyMandate accepts a signMandate JWS and rejects a tampered one", async () => {
  const { mandate } = fixtures.storedMandate;
  const key = await buyerJwk();
  const jws = await signMandate(mandate, key);

  expect(decodeProtectedHeader(jws)).toMatchObject({ alg: "ES256", typ: "mandate+jwt" });
  expect(await verifyMandate(jws, key)).toEqual(ok(mandate));
  const { d: _d, ...publicJwk } = key;
  expect(await verifyMandate(jws, publicJwk)).toEqual(ok(mandate));

  const [header, , signature] = jws.split(".");
  const raised = {
    ...mandate,
    limits: {
      ...mandate.limits,
      maxOrderTotal: { ...mandate.limits.maxOrderTotal, value: 99_999 },
    },
  };
  const tampered = `${header}.${base64url(JSON.stringify(raised))}.${signature}`;
  expect(await verifyMandate(tampered, key)).toEqual(err("MANDATE_INVALID"));

  expect(await verifyMandate(jws, await buyerJwk())).toEqual(err("MANDATE_INVALID"));
  expect(await verifyMandate("not-a-jws", key)).toEqual(err("MANDATE_INVALID"));
});

test("signMandate and verifyMandate throw on an unusable buyer key instead of calling every mandate invalid", async () => {
  const { mandate } = fixtures.storedMandate;
  const key = await buyerJwk();
  const jws = await signMandate(mandate, key);
  const { d: _d, ...publicJwk } = key;

  expect(await failure(signMandate(mandate, publicJwk))).toContain(
    "not a private ES256 (P-256) JWK",
  );
  expect(await failure(verifyMandate(jws, { kty: "oct", k: "c2VjcmV0" }))).toContain(
    "not a P-256 JWK",
  );
});
