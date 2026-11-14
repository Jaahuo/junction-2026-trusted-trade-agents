import { SQL } from "bun";
import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, fixtures, type StoredMandate, StoredMandateSchema } from "@app/contract";
import { verifyMandate } from "@app/contract/server";
import { closeDb, type Db, env, mountContext, openDb } from "@app/server-kit";
import type { AnyElysia } from "elysia";
import { buyerSigner } from "../infra/buyer-key.ts";
import { context, createApi } from "./index.ts";

const withDatabase = async (run: (db: Db) => Promise<void>): Promise<void> => {
  const value = env("TEST_DATABASE_URL");
  if (value === undefined)
    throw new Error("TEST_DATABASE_URL must point to a disposable local PostgreSQL server");
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search !== "")
    throw new Error("TEST_DATABASE_URL must use a local PostgreSQL server");
  const name = `test_mandates_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(value);
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const db = openDb(url.toString());
    try {
      await run(db);
    } finally {
      try {
        await closeDb(db);
      } finally {
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    }
  } finally {
    await admin.close();
  }
};

const buyerKey: JsonWebKey = {
  ...(await crypto.subtle.exportKey(
    "jwk",
    (
      await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ])
    ).privateKey,
  )),
  alg: "ES256",
};

/** The register fixture without an operationId, so each register stores a new mandate. */
const { operationId: _operationId, ...request } = fixtures.registerMandateRequest;

/** Mounts the context with migrations, a clock the test moves and a test buyer key. */
const mount = async (db: Db) => {
  await mountContext(db, context);
  const clock = { now: new Date("2026-11-14T10:00:00Z") };
  const sign = buyerSigner(async () => buyerKey);
  return { app: createApi(db, () => clock.now, sign), clock };
};

const call = (app: AnyElysia, method: string, path: string, body?: object) =>
  app.handle(
    new Request(`http://localhost/mandates${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );

const register = async (app: AnyElysia, body: object = request) => {
  const response = await call(app, "POST", "", body);
  expect(response.status).toBe(201);
  return StoredMandateSchema.parse(await response.json());
};

const current = async (app: AnyElysia): Promise<StoredMandate | number> => {
  const response = await call(app, "GET", "/current");
  return response.status === 200
    ? StoredMandateSchema.parse(await response.json())
    : response.status;
};

test("register revokes the previous mandate, gives version + 1 and a new mandateId, and sets iss, agent and signedBy from the principal", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const first = await register(app);
    const second = await register(app);
    expect(second.mandate).toMatchObject({
      version: first.mandate.version + 1,
      iss: DEMO_ACCOUNT.customer,
      agent: DEMO_ACCOUNT.agentId,
      signedBy: DEMO_ACCOUNT.accountId,
    });
    expect(second.mandate.mandateId).not.toBe(first.mandate.mandateId);
    expect(second.status).toBe("active");
    expect(await current(app)).toEqual(second);
    const revoked = await call(app, "POST", `/${first.mandate.mandateId}/revoke`);
    expect(await revoked.json()).toMatchObject({ status: "revoked" });
  }));

for (const offset of [-1, 0]) {
  test(`register rejects expiry ${offset === 0 ? "at" : "before"} now without changing the current mandate`, async () =>
    withDatabase(async (db) => {
      const { app, clock } = await mount(db);
      clock.now = new Date("2026-11-14T10:00:00.500Z");
      const now = Math.floor(clock.now.getTime() / 1000);
      const first = await register(app, { ...request, exp: now + 100 });
      const before = await db.$client`select count(*)::int as n from mandates_mandates`;

      const response = await call(app, "POST", "", { ...request, exp: now + offset });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
      expect(await current(app)).toEqual(first);
      expect(await db.$client`select count(*)::int as n from mandates_mandates`).toEqual(before);
      expect(before).toEqual([{ n: 1 }]);

      const next = await register(app, { ...request, exp: now + 1 });
      expect(next.mandate.version).toBe(first.mandate.version + 1);
      expect(next.mandate.exp).toBe(now + 1);
      expect(await current(app)).toEqual(next);
    }));
}

test("two parallel registers leave one active mandate", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const responses = await Promise.all([
      call(app, "POST", "", request),
      call(app, "POST", "", request),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const stored = await Promise.all(
      responses.map(async (response) => StoredMandateSchema.parse(await response.json())),
    );
    expect(stored.map((entry) => entry.mandate.version).toSorted((a, b) => a - b)).toEqual([1, 2]);
    const active =
      await db.$client`select count(*)::int as n from mandates_mandates where status = 'active'`;
    expect(active).toEqual([{ n: 1 }]);
  }));

test("after revoke, GET current gives 404; an expired mandate is not current", async () =>
  withDatabase(async (db) => {
    const { app, clock } = await mount(db);
    const first = await register(app);
    const revoked = await call(app, "POST", `/${first.mandate.mandateId}/revoke`);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ status: "revoked" });
    const missing = await call(app, "GET", "/current");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const second = await register(app, { ...request, exp: undefined });
    expect(second.mandate.version).toBe(2);
    expect(await current(app)).toEqual(second);
    clock.now = new Date(second.mandate.exp * 1000);
    expect(await current(app)).toBe(404);
  }));

test("revoking an unknown mandateId gives 404 and an already revoked one returns it", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    expect((await call(app, "POST", "/mnd_missing/revoke")).status).toBe(404);
    const stored = await register(app);
    const path = `/${stored.mandate.mandateId}/revoke`;
    expect((await call(app, "POST", path)).status).toBe(200);
    const again = await call(app, "POST", path);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "revoked" });
  }));

const forbidden = {
  iss: "cust_other",
  agent: "agent_other",
  signedBy: "acct_other",
  mandateId: "mnd_chosen",
  version: 7,
  iat: 1,
  customer: "cust_other",
};

test("a body with iss, agent, signedBy, mandateId, version, iat or customer gives 400", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    for (const [key, value] of Object.entries(forbidden)) {
      const response = await call(app, "POST", "", {
        ...request,
        [key]: value,
      });
      expect({ key, status: response.status, body: await response.json() }).toEqual({
        key,
        status: 400,
        body: { error: { code: "BAD_REQUEST", message: expect.any(String) } },
      });
    }
    const revoke = await call(app, "POST", "/mnd_any/revoke", { customer: "cust_other" });
    expect(revoke.status).toBe(400);
    expect(await current(app)).toBe(404);
  }));

test("seed registers the demo mandate as version 1 of the demo agent", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    await context.seed?.(db);
    const stored = await current(app);
    expect(stored).toMatchObject({
      status: "active",
      mandate: {
        version: 1,
        agent: "agent_demo",
        limits: { maxOrderTotal: { value: 1000, currency: "EUR", basis: "gross" } },
      },
    });
  }));

const payloadOf = (jws: string): unknown => {
  const [, payload] = jws.split(".");
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
};

test("register stores a jws that decodes to exactly the stored mandate, including the server-set mandateId, version and iat", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    await register(app);
    const stored = await register(app);
    if (stored.jws === null) throw new Error("expected a jws");
    expect(payloadOf(stored.jws)).toEqual(stored.mandate);
    expect(stored.mandate.version).toBe(2);
    expect(await current(app)).toEqual(stored);
  }));

test("verifyMandate of the stored jws succeeds; a tampered stored jws fails", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const { jws, mandate } = await register(app);
    if (jws === null) throw new Error("expected a jws");
    const { d: _d, ...publicKey } = buyerKey;
    expect(await verifyMandate(jws, publicKey)).toEqual({ ok: true, value: mandate });
    const [header, , signature] = jws.split(".");
    const raised = {
      ...mandate,
      limits: { ...mandate.limits, maxOrderTotal: { ...mandate.limits.maxOrderTotal, value: 1e6 } },
    };
    const tampered = `${header}.${Buffer.from(JSON.stringify(raised)).toString("base64url")}.${signature}`;
    expect(await verifyMandate(tampered, publicKey)).toEqual({
      ok: false,
      error: "MANDATE_INVALID",
    });
  }));

test("two registers with one operationId store one mandate and return it twice, the second with 200", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const body = { ...request, operationId: "op_once" };
    const first = await call(app, "POST", "", body);
    expect(first.status).toBe(201);
    const stored = StoredMandateSchema.parse(await first.json());
    const again = await call(app, "POST", "", {
      ...body,
      limits: { ...request.limits, newProducts: "auto" },
    });
    expect(again.status).toBe(200);
    expect(StoredMandateSchema.parse(await again.json())).toEqual(stored);
    expect(await current(app)).toEqual(stored);
    const rows = await db.$client`select count(*)::int as n from mandates_mandates`;
    expect(rows).toEqual([{ n: 1 }]);
  }));

test("replaying an expired operationId returns its stored mandate without changing a newer mandate", async () =>
  withDatabase(async (db) => {
    const { app, clock } = await mount(db);
    const now = Math.floor(clock.now.getTime() / 1000);
    const body = { ...request, operationId: "op_expired_replay", exp: now + 10 };
    const original = await register(app, body);
    const newer = await register(app, { ...request, exp: now + 100 });
    clock.now = new Date((now + 10) * 1000);
    const before = await db.$client`select count(*)::int as n from mandates_mandates`;

    const replay = await call(app, "POST", "", body);
    expect(replay.status).toBe(200);
    expect(StoredMandateSchema.parse(await replay.json())).toEqual({
      ...original,
      status: "revoked",
    });
    expect(await current(app)).toEqual(newer);
    expect(await db.$client`select count(*)::int as n from mandates_mandates`).toEqual(before);
    expect(before).toEqual([{ n: 2 }]);
  }));

test("parallel registers with one operationId store one mandate", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const body = { ...request, operationId: "op_parallel" };
    const responses = await Promise.all([call(app, "POST", "", body), call(app, "POST", "", body)]);
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 201,
    ]);
    const bodies = await Promise.all(responses.map(async (response) => response.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    const rows = await db.$client`select count(*)::int as n from mandates_mandates`;
    expect(rows).toEqual([{ n: 1 }]);
  }));

test("a body with a jws field gives 400", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const response = await call(app, "POST", "", { ...request, jws: "a.b.c" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(await current(app)).toBe(404);
  }));
