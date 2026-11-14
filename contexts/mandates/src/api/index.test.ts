import { SQL } from "bun";
import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, fixtures, type StoredMandate, StoredMandateSchema } from "@app/contract";
import { closeDb, type Db, env, mountContext, openDb } from "@app/server-kit";
import type { AnyElysia } from "elysia";
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

/** Mounts the context with migrations and a clock the test moves. */
const mount = async (db: Db) => {
  await mountContext(db, context);
  const clock = { now: new Date("2026-11-14T10:00:00Z") };
  return { app: createApi(db, () => clock.now), clock };
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

const register = async (app: AnyElysia, body: object = fixtures.registerMandateRequest) => {
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
    expect(second).toMatchObject({ status: "active", jws: null });
    expect(await current(app)).toEqual(second);
    const revoked = await call(app, "POST", `/${first.mandate.mandateId}/revoke`);
    expect(await revoked.json()).toMatchObject({ status: "revoked" });
  }));

test("two parallel registers leave one active mandate", async () =>
  withDatabase(async (db) => {
    const { app } = await mount(db);
    const responses = await Promise.all([
      call(app, "POST", "", fixtures.registerMandateRequest),
      call(app, "POST", "", fixtures.registerMandateRequest),
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

    const second = await register(app, { ...fixtures.registerMandateRequest, exp: undefined });
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
        ...fixtures.registerMandateRequest,
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
