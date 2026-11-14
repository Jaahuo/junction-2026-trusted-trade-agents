import {
  ErrorEnvelopeSchema,
  fixtures,
  type MandateLimits,
  type OfferClaims,
  type Order,
  OrderSchema,
  StoredMandateSchema,
} from "@app/contract";
import { localOfferKeys, type OfferSigningKey, signOfferToken } from "@app/contract/server";
import { type Db, mountContext } from "@app/server-kit";
import { context as mandatesContext, createApi as createMandatesApi } from "@ctx/mandates/api";
import type { AnyElysia } from "elysia";
import { mandateClient } from "../infra/mandate-client.ts";
import { offerVerifier } from "../infra/offer-verifier.ts";
import { type ApiDeps, context, createApi } from "./index.ts";

const now = new Date("2026-11-16T08:00:00Z");
export const inMinutes = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const testKey = async (): Promise<OfferSigningKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const kid = "offer-test";
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  return { kid, privateKey: pair.privateKey, publicJwk };
};

export const limitsWith = (changes: Partial<MandateLimits> = {}): MandateLimits => ({
  ...fixtures.registerMandateRequest.limits,
  newProducts: "auto",
  ...changes,
});

/** The orders context and the real mandates context on one test database, with a test signing key. */
export const mount = async (db: Db) => {
  await mountContext(db, mandatesContext);
  await mountContext(db, context);
  const mandates = createMandatesApi(db, () => now);
  const key = await testKey();
  const keys = localOfferKeys({ keys: [key.publicJwk] });
  // Stands in for PUBLIC_BASE_URL, which the server reads on every response.
  const publicBase = { url: "https://orders.test" };
  // The orders clock; a test moves it to act later on stored orders.
  const clock = { now };
  const appWith = (changes: Partial<ApiDeps> = {}) =>
    createApi(db, {
      verifyOffer: offerVerifier(async () => keys),
      mandates: mandateClient(mandates),
      now: () => clock.now,
      publicBaseUrl: () => publicBase.url,
      ...changes,
    });
  const app = appWith();
  const register = async (limits: MandateLimits = limitsWith()) => {
    const response = await mandates.handle(
      new Request("http://localhost/mandates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limits, standingConstraints: { hard: [], soft: [] } }),
      }),
    );
    return StoredMandateSchema.parse(await response.json()).mandate;
  };
  const mandate = await register();
  const sign = (changes: Partial<OfferClaims> = {}, exp = inMinutes(10)) => {
    const { iat: _iat, exp: _exp, ...claims } = fixtures.offerClaims;
    return signOfferToken(
      {
        ...claims,
        offerId: `off_${crypto.randomUUID()}`,
        mandateId: mandate.mandateId,
        mandateVersion: mandate.version,
        ...changes,
      },
      key,
      exp,
    );
  };
  return { app, appWith, clock, mandates, mandate, register, sign, publicBase };
};

export const call = (app: AnyElysia, method: string, path: string, body?: object) =>
  app.handle(
    new Request(`http://localhost/orders${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );

export const place = (app: AnyElysia, offers: string[], extra: object = {}) =>
  call(app, "POST", "", { offers, idempotencyKey: crypto.randomUUID(), ...extra });

export const orderOf = async (response: Response): Promise<Order> =>
  OrderSchema.parse(await response.json());

export const errorOf = async (response: Response) =>
  ErrorEnvelopeSchema.parse(await response.json()).error.code;

const count = async (db: Db, table: string): Promise<number> => {
  const [row] = await db.$client.unsafe(`select count(*)::int as n from ${table}`);
  return Number(row?.n);
};

export const counts = async (db: Db) => ({
  orders: await count(db, "orders_orders"),
  refusals: await count(db, "orders_refusals"),
  history: await count(db, "orders_history"),
});

export const overLimit = { total: { net: 1100, gross: 1250 } };
