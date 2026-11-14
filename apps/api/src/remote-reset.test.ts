import { SQL } from "bun";
import { expect, test } from "bun:test";
import { closeDb, type Db, discoverContexts, env, openDb } from "@app/server-kit";
import { resetContexts } from "./remote-reset.ts";

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

test("reset twice keeps a foreign public table and restores each context to its seeded state", async () => {
  await withDatabase(async (db) => {
    await db.$client`CREATE TABLE public.extension_owned (id int)`;
    await db.$client`INSERT INTO public.extension_owned VALUES (1)`;
    const contexts = await discoverContexts();

    await resetContexts(db, contexts);
    const seeded = await publicTables(db);
    const notesAfterFirst = await countRows(db, "notes_notes");
    await db.$client`INSERT INTO notes_notes (id, text, "createdAt") VALUES ('stale', 'stale', 0)`;

    await resetContexts(db, contexts);

    expect(await publicTables(db)).toEqual(seeded);
    expect(seeded).toContain("extension_owned");
    expect(seeded).toContain("notes_notes");
    expect(await countRows(db, "public.extension_owned")).toBe(1);
    expect(notesAfterFirst).toBeGreaterThan(0);
    expect(await countRows(db, "notes_notes")).toBe(notesAfterFirst);
  });
});
