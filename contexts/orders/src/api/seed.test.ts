import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, type DemoProducts } from "@app/contract";
import { type Db, mountContext } from "@app/server-kit";
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

test("the seed uses imported demo metadata for history", async () =>
  withSeedDatabase(async (db) => {
    await seedHistory(db, { demo, warn: () => undefined });
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
  }));

test("without imported demo metadata the seed adds no history and warns once", async () =>
  withSeedDatabase(async (db) => {
    const warnings: string[] = [];
    await seedHistory(db, {
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(await db.select().from(history)).toEqual([]);
  }));
