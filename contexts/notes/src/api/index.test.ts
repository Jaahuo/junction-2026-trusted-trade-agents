import { SQL } from "bun";
import { expect, test } from "bun:test";
import { ok } from "@app/kernel";
import { closeDb, type Db, env, mountContext, openDb } from "@app/server-kit";
import type { AnyElysia } from "elysia";
import { createSummarizer } from "../infra/claude-summarizer.ts";
import { context, createApi } from "./index.ts";

const withDatabase = async (run: (db: Db) => Promise<void>): Promise<void> => {
  const value = env("TEST_DATABASE_URL");
  if (value === undefined)
    throw new Error(
      "TEST_DATABASE_URL must point to a disposable local PostgreSQL server with CREATEDB permission",
    );
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.search !== ""
  ) {
    throw new Error(
      "TEST_DATABASE_URL must use a local PostgreSQL server without connection overrides",
    );
  }
  const name = `test_notes_${crypto.randomUUID().replaceAll("-", "")}`;
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

const post = (app: AnyElysia, path: string, body?: object) =>
  app.handle(
    new Request(`http://localhost/notes${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
const list = async (app: AnyElysia) =>
  (await app.handle(new Request("http://localhost/notes"))).json();

test("a posted note is returned by the list", async () =>
  withDatabase(async (db) => {
    const app = await mountContext(db, context);
    expect((await post(app, "", { text: "buy milk" })).status).toBe(200);
    expect(await list(app)).toMatchObject([{ text: "buy milk" }]);
  }));

test("an empty note is rejected with 400", async () =>
  withDatabase(async (db) => {
    const app = await mountContext(db, context);
    const response = await post(app, "", { text: "  " });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "empty-text" });
  }));

test("the summary sends every note text to the summarizer", async () =>
  withDatabase(async (db) => {
    const seen: string[] = [];
    const summarizer = {
      summarize: async (texts: readonly string[]) => {
        seen.push(...texts);
        return ok("two notes");
      },
    };
    const app = await mountContext(db, {
      ...context,
      api: (database) => createApi(database, summarizer),
    });
    await post(app, "", { text: "first" });
    await post(app, "", { text: "second" });
    const response = await post(app, "/summary");
    expect(await response.json()).toEqual({ summary: "two notes" });
    expect(seen.toSorted()).toEqual(["first", "second"]);
  }));

test("the summary answers 503 when no api key is configured", async () =>
  withDatabase(async (db) => {
    const app = await mountContext(db, {
      ...context,
      api: (database) => createApi(database, createSummarizer(undefined)),
    });
    await post(app, "", { text: "first" });
    const response = await post(app, "/summary");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "summarizer-not-configured" });
  }));
