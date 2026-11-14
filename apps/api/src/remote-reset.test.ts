import { SQL } from "bun";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMandate } from "@app/contract/server";
import { closeDb, type Db, discoverContexts, env, openDb } from "@app/server-kit";
import { importCatalogue, migrateCatalogue, readDemoProducts } from "@ctx/catalog/api";
import { writeFictionalSources } from "../../../contexts/catalog/src/infra/test-fixtures.ts";
import { migrationManifest, resetContexts } from "./remote-reset.ts";

const withDatabase = async (run: (db: Db) => Promise<void>): Promise<void> => {
  const value = env("TEST_DATABASE_URL");
  if (value === undefined)
    throw new Error("TEST_DATABASE_URL must point to a disposable local PostgreSQL server");
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search !== "")
    throw new Error("TEST_DATABASE_URL must use a local PostgreSQL server");
  const name = `test_remote_reset_${crypto.randomUUID().replaceAll("-", "")}`;
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
        await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    }
  } finally {
    await admin.close();
  }
};

const publicTables = async (db: Db): Promise<string[]> =>
  (
    await db.$client<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  ).map(({ name }) => name);

const countRows = async (db: Db, table: string): Promise<number | undefined> =>
  (await db.$client.unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM ${table}`))[0]
    ?.count;

test("the manifest lists exactly the tables a context's migrations create", async () => {
  expect(await migrationManifest("notes")).toEqual({ tables: ["notes_notes"], types: [] });
  expect(await migrationManifest("no-such-context")).toEqual({ tables: [], types: [] });
});

test("reset twice keeps a same-owner table with a colliding prefix and restores each context to its seeded state", async () => {
  await withDatabase(async (db) => {
    await db.$client`CREATE TABLE public.notes_external (id int)`;
    await db.$client`INSERT INTO public.notes_external VALUES (1)`;
    const contexts = await discoverContexts();

    await resetContexts(db, contexts);
    const seeded = await publicTables(db);
    const notesAfterFirst = await countRows(db, "notes_notes");
    await db.$client`INSERT INTO notes_notes (id, text, "createdAt") VALUES ('stale', 'stale', 0)`;

    await resetContexts(db, contexts);

    expect(await publicTables(db)).toEqual(seeded);
    expect(seeded).toContain("notes_external");
    expect(seeded).toContain("notes_notes");
    expect(await countRows(db, "public.notes_external")).toBe(1);
    expect(notesAfterFirst).toBeGreaterThan(0);
    expect(await countRows(db, "notes_notes")).toBe(notesAfterFirst);
  });
});

test("every seed can call mounted context routes in process, and orders sees the seeded mandate", async () => {
  await withDatabase(async (db) => {
    const contexts = await discoverContexts();
    const first = contexts[0];
    const orders = contexts.find((context) => context.name === "orders");
    if (first === undefined || orders === undefined || first.name === "orders")
      throw new Error("Expected a context before orders and the orders context");
    let earlyCalled = false;
    let ordersCalled = false;
    const wrapped = contexts.map((context) => {
      if (context === first)
        return Object.assign({}, context, {
          seed: async (seedDb: Db, inputs?: Parameters<NonNullable<typeof context.seed>>[1]) => {
            if (inputs?.fetcher === undefined) throw new Error("Missing in-process fetcher");
            const response = await inputs.fetcher(
              new Request("http://localhost/api/mandates/current"),
            );
            expect(response.status).toBe(404);
            expect(await response.json()).toMatchObject({
              error: { code: "NOT_FOUND", message: "No current mandate." },
            });
            earlyCalled = true;
            await context.seed?.(seedDb, inputs);
          },
        });
      if (context === orders)
        return Object.assign({}, context, {
          seed: async (seedDb: Db, inputs?: Parameters<NonNullable<typeof context.seed>>[1]) => {
            if (inputs?.fetcher === undefined) throw new Error("Missing in-process fetcher");
            const response = await inputs.fetcher(
              new URL("http://localhost/api/mandates/current"),
              {
                method: "GET",
              },
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
              status: "active",
              mandate: { version: 1 },
            });
            ordersCalled = true;
            await context.seed?.(seedDb, inputs);
          },
        });
      return context;
    });
    await resetContexts(db, wrapped);
    expect(earlyCalled).toBe(true);
    expect(ordersCalled).toBe(true);
  });
});

test("a foreign view on one of our tables aborts the reset before anything is dropped", async () => {
  await withDatabase(async (db) => {
    const contexts = await discoverContexts();
    await resetContexts(db, contexts);
    await db.$client`INSERT INTO notes_notes (id, text, "createdAt") VALUES ('kept', 'kept', 0)`;
    await db.$client`CREATE VIEW public.foreign_report AS SELECT id FROM notes_notes`;
    const before = await publicTables(db);

    const failure = await resetContexts(db, contexts).then(
      () => "no error",
      (error: unknown) => String(error),
    );
    expect(failure).toMatch(/depend/);

    expect(await publicTables(db)).toEqual(before);
    expect(await countRows(db, "public.foreign_report")).toBe(await countRows(db, "notes_notes"));
    expect(await countRows(db, `notes_notes WHERE id = 'kept'`)).toBe(1);
  });
});

test("the seeded mandate verifies with the buyer key the reset ran with", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const hostedKey = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), alg: "ES256" };
  const { d: _d, ...publicKey } = hostedKey;
  const previous = process.env["BUYER_SIGNING_JWK"];
  process.env["BUYER_SIGNING_JWK"] = JSON.stringify(hostedKey);
  try {
    await withDatabase(async (db) => {
      await resetContexts(db, await discoverContexts());
      const rows = await db.$client<{ jws: string | null }[]>`SELECT jws FROM mandates_mandates`;
      expect(rows.length).toBeGreaterThan(0);
      for (const { jws } of rows)
        expect(await verifyMandate(jws ?? "", publicKey)).toMatchObject({ ok: true });
    });
  } finally {
    if (previous === undefined) delete process.env["BUYER_SIGNING_JWK"];
    else process.env["BUYER_SIGNING_JWK"] = previous;
  }
});

test("repeated demo resets preserve every catalogue row and its migration ledger", async () => {
  await withDatabase(async (db) => {
    const dir = await mkdtemp(join(tmpdir(), "catalogue-reset-"));
    try {
      await writeFictionalSources(dir);
      await migrateCatalogue(db);
      await importCatalogue(db, dir);
      const snapshot = async () => ({
        products: await db.$client`SELECT * FROM catalog_products ORDER BY ordinal`,
        enrichments: await db.$client`SELECT * FROM catalog_csv_rows ORDER BY source, ordinal`,
        manifest: await db.$client`SELECT * FROM catalog_manifest ORDER BY id`,
        ledger: await db.$client`SELECT * FROM drizzle.__migrations_catalog ORDER BY id`,
      });
      const before = await snapshot();
      const demo = await readDemoProducts(db);
      if (demo === null) throw new Error("Fixture has no demo metadata");
      const contexts = await discoverContexts();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await resetContexts(db, contexts);
        expect(await snapshot()).toEqual(before);
        const seeded = await db.$client<
          { productId: string }[]
        >`SELECT "productId" FROM orders_history`;
        expect(seeded.map((row) => row.productId)).toEqual([
          ...Array.from({ length: 3 }, () => demo.s1.productId),
          ...Array.from({ length: 3 }, () => demo.s2.productId),
          "prod_demo_activity_placed",
        ]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
