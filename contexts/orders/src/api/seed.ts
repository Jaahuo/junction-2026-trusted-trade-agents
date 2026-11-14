import { DEMO_ACCOUNT, DemoProductsSchema, type Quantity } from "@app/contract";
import { type Db, type SeedInputs } from "@app/server-kit";
import type { HistoryRow } from "../domain/evaluate.ts";
import { history } from "../infra/schema.ts";

const times = (rows: number, productId: string, quantity: Quantity): HistoryRow[] =>
  Array.from({ length: rows }, () => ({ productId, quantity }));

const fifth = (quantity: Quantity): Quantity => ({
  value: Math.ceil(quantity.value / 5),
  unit: quantity.unit,
});

// Three observations per scenario keep repeat orders inside the demo's quantity limits.
export const seedHistory = async (
  db: Db,
  options: { demo?: unknown; warn?: (message: string) => void } = {},
): Promise<void> => {
  const warn = options.warn ?? console.error;
  if (options.demo === undefined || options.demo === null) {
    warn("No imported demo metadata, so the demo customer gets no order history.");
    return;
  }
  const demo = DemoProductsSchema.parse(options.demo);
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

export const seed = (db: Db, inputs?: SeedInputs): Promise<void> =>
  seedHistory(db, { demo: inputs?.demoProducts });
