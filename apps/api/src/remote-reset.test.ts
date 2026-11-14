import { SQL } from "bun";
import { expect, test } from "bun:test";
import { verifyMandate } from "@app/contract/server";
import { closeDb, type Db, discoverContexts, env, openDb } from "@app/server-kit";
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
