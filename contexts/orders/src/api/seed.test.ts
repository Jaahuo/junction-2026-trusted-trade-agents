import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_ACCOUNT, type DemoProducts } from "@app/contract";
import { type Db, mountContext } from "@app/server-kit";
import { postgresOrderStore } from "../infra/order-store.ts";
import { history } from "../infra/schema.ts";
import { context } from "./index.ts";
import { seedHistory } from "./seed.ts";
import { withDatabase } from "./test-database.ts";

const withSeedDatabase = (run: (db: Db) => Promise<void>) =>
  withDatabase(async (db) => {
    await mountContext(db, context);
    await run(db);
  });

// Invented products (team rules R-23).
const demo: DemoProducts = {
  observedAt: "2026-11-14T08:00:00Z",
  requestedDate: "2026-11-16",
  s1: { productId: "prod_test_small", quantity: { value: 20, unit: "LTR" } },
  s2: { productId: "prod_test_large", quantity: { value: 1001, unit: "LTR" } },
  s3: null,
  late: null,
  triedForS3: [],
};

test("the seed reads the demo products file for history", async () =>
  withSeedDatabase(async (db) => {
    const dir = await mkdtemp(join(tmpdir(), "orders-seed-"));
    try {
      const path = join(dir, "demo-products.json");
      await Bun.write(path, JSON.stringify(demo));
      await seedHistory(db, { path, warn: () => undefined });
      const rows = await db
        .select({
          customer: history.customer,
          productId: history.productId,
          quantity: history.quantity,
        })
        .from(history);
      const small = {
        customer: DEMO_ACCOUNT.customer,
        productId: "prod_test_small",
        quantity: { value: 20, unit: "LTR" },
      };
      const large = {
        customer: DEMO_ACCOUNT.customer,
        productId: "prod_test_large",
        quantity: { value: 201, unit: "LTR" },
      };
      expect(rows).toEqual([small, small, small, large, large, large]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));

test("without the file the seed adds no history and warns once", async () =>
  withSeedDatabase(async (db) => {
    const warnings: string[] = [];
    await seedHistory(db, {
      path: join(tmpdir(), `missing-${crypto.randomUUID()}.json`),
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(await db.select().from(history)).toEqual([]);
  }));

test("with a scenario 3 substitute the seed adds two approvals of the pair and its history", async () =>
  withSeedDatabase(async (db) => {
    const dir = await mkdtemp(join(tmpdir(), "orders-seed-"));
    try {
      const path = join(dir, "demo-products.json");
      await Bun.write(
        path,
        JSON.stringify({
          ...demo,
          s3: { productId: "prod_test_partial", quantity: { value: 220, unit: "ST" } },
          s3Substitute: { productId: "prod_test_substitute" },
        }),
      );
      await seedHistory(db, { path, warn: () => undefined });
      const pair = { replaces: "prod_test_partial", productId: "prod_test_substitute" };
      const approved = await postgresOrderStore(db).withCustomerLock(DEMO_ACCOUNT.customer, (tx) =>
        tx.withPair(DEMO_ACCOUNT.customer, pair),
      );
      expect(approved.map((order) => [order.status, order.decision?.action])).toEqual([
        ["placed", "approve"],
        ["placed", "approve"],
      ]);
      const substituteRows = (await db.select().from(history)).filter(
        (row) => row.productId === pair.productId,
      );
      expect(substituteRows).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));
