import { SQL } from "bun";
import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, OffersResultSchema } from "@app/contract";
import { closeDb, contextsDir, type Db, env, mountContext, openDb } from "@app/server-kit";
import { Elysia } from "elysia";
import { fakeAvailability, fakeOffersDeps, fakePrice, fakeProduct } from "../application/fakes.ts";
import { createApi } from "./routes.ts";

// Invented products only (team rules R-23).
const OAT = "prod_test_oat";
const databaseUrl = env("TEST_DATABASE_URL");

if (databaseUrl === undefined) {
  console.error(
    "no-writes: TEST_DATABASE_URL is unset, so the row-count case is SKIPPED. Run `bun run runtime:setup` to create it.",
  );
}

const withDatabase = async (url: string, run: (db: Db) => Promise<void>): Promise<void> => {
  const target = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.search !== ""
  ) {
    throw new Error(
      "TEST_DATABASE_URL must use a local PostgreSQL server without connection overrides",
    );
  }
  const name = `test_offers_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(url);
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    target.pathname = `/${name}`;
    const db = openDb(target.toString());
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

const rowCounts = async (db: Db): Promise<Map<string, number>> => {
  const tables: { name: string }[] = await db.$client.unsafe(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  const counts = new Map<string, number>();
  for (const { name } of tables) {
    const [row]: { n: number }[] = await db.$client.unsafe(
      `SELECT count(*)::int AS n FROM "${name}"`,
    );
    counts.set(name, row?.n ?? 0);
  }
  return counts;
};

test.skipIf(databaseUrl === undefined)(
  "get_offers leaves orders, credit and audit rows unchanged (row counts before and after)",
  async () => {
    if (databaseUrl === undefined) return;
    await withDatabase(databaseUrl, async (db) => {
      const names = [
        ...new Bun.Glob("*/migrations").scanSync({ cwd: contextsDir, onlyFiles: false }),
      ].map((path) => path.split("/")[0] ?? path);
      for (const name of names) await mountContext(db, { name, api: () => new Elysia() });

      const fake = fakeOffersDeps({
        products: [fakeProduct(OAT)],
        live: {
          [OAT]: {
            availability: { "*": fakeAvailability(OAT) },
            prices: { "*": fakePrice(OAT) },
          },
        },
      });
      const app = await mountContext(db, { name: "offers", api: () => createApi(fake.deps) });

      const before = await rowCounts(db);
      const response = await app.handle(
        new Request("http://localhost/offers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lines: [{ productId: OAT, quantity: { value: 4, unit: "CT" } }],
            deliverBy: "2026-11-20",
            paymentTerms: DEMO_ACCOUNT.paymentTerms,
            hard: [],
            soft: [],
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(OffersResultSchema.parse(await response.json()).offers.length).toBeGreaterThan(0);
      const after = await rowCounts(db);

      const watched = [...before.keys()].filter(
        (name) => name.startsWith("orders_") || name.includes("credit") || name.includes("audit"),
      );
      console.log(`no-writes tables: ${watched.join(", ")}`);
      expect(before.size).toBeGreaterThan(0);
      expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before));
    });
  },
);
