import { resolve } from "node:path";
import { DEMO_ACCOUNT, DemoProductsSchema, type Quantity } from "@app/contract";
import { contextsDir, type Db } from "@app/server-kit";
import type { HistoryRow } from "../domain/evaluate.ts";
import { history } from "../infra/schema.ts";

const demoProductsPath = resolve(contextsDir, "..", "data", "demo-products.json");

const times = (rows: number, productId: string, quantity: Quantity): HistoryRow[] =>
  Array.from({ length: rows }, () => ({ productId, quantity }));

const fifth = (quantity: Quantity): Quantity => ({
  value: Math.ceil(quantity.value / 5),
  unit: quantity.unit,
});

/**
 * Order history of the demo customer (SPEC-015), so scenario 1 gives no reason and scenario 2 only
 * the spend limit: three rows of the scenario 1 quantity, three of a fifth of the larger requests.
 */
export const seedHistory = async (
  db: Db,
  options: { path?: string; warn?: (message: string) => void } = {},
): Promise<void> => {
  const path = options.path ?? demoProductsPath;
  const warn = options.warn ?? console.error;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    warn(`${path} is missing, so the demo customer gets no order history.`);
    return;
  }
  const demo = DemoProductsSchema.parse(await file.json());
  const rows = [
    ...times(3, demo.s1.productId, demo.s1.quantity),
    ...times(3, demo.s2.productId, fifth(demo.s2.quantity)),
    ...(demo.s3 === null ? [] : times(3, demo.s3.productId, fifth(demo.s3.quantity))),
  ];
  const placedAt = new Date(demo.observedAt);
  await db.insert(history).values(
    rows.map(({ productId, quantity }) => ({
      customer: DEMO_ACCOUNT.customer,
      productId,
      quantity,
      placedAt,
    })),
  );
};

export const seed = (db: Db): Promise<void> => seedHistory(db);
