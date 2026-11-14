import { resolve } from "node:path";
import {
  DEMO_ACCOUNT,
  type DemoProducts,
  DemoProductsSchema,
  fixtures,
  type Quantity,
} from "@app/contract";
import { contextsDir, type Db } from "@app/server-kit";
import type { HistoryRow } from "../domain/evaluate.ts";
import type { StoredOrder } from "../application/ports.ts";
import { postgresOrderStore } from "../infra/order-store.ts";
import { history } from "../infra/schema.ts";

const demoProductsPath = resolve(contextsDir, "..", "data", "demo-products.json");

const times = (rows: number, productId: string, quantity: Quantity): HistoryRow[] =>
  Array.from({ length: rows }, () => ({ productId, quantity }));

const fifth = (quantity: Quantity): Quantity => ({
  value: Math.ceil(quantity.value / 5),
  unit: quantity.unit,
});

/** Approvals of the scenario 3 substitute before the demo; the next one offers a standing rule. */
const EARLIER_APPROVALS = 2;

/**
 * An approved, placed order of the scenario 3 substitute alone. Its lines name products by id:
 * the seed copies no other value of the dataset (team rules R-23).
 */
const approvedSubstitute = (
  demo: DemoProducts,
  replaces: string,
  productId: string,
  index: number,
): StoredOrder => {
  const at = demo.observedAt;
  const quantity = fifth(demo.s3?.quantity ?? { value: 1, unit: "ST" });
  const claims = {
    ...fixtures.offerClaims,
    offerId: `off_seed_substitute_${index}`,
    productId,
    quantity,
    replaces,
    deliveryDate: demo.requestedDate,
    requestedDate: demo.requestedDate,
    product: { ...fixtures.offerClaims.product, name: productId },
  };
  return {
    ...fixtures.order,
    orderId: `ord_seed_substitute_${index}`,
    idempotencyKey: `seed-substitute-${index}`,
    requested: { offers: [], alternatives: [] },
    offerIds: [claims.offerId],
    lines: [{ offerId: claims.offerId, token: "seed", claims }],
    status: "placed",
    reasons: ["SUBSTITUTION"],
    total: claims.total,
    originalRequest: null,
    decision: { action: "approve", next: null, note: null, by: DEMO_ACCOUNT.accountId, at },
    nextDeliveryDate: null,
    audit: [
      { at, actor: "agent", event: "order_requested" },
      { at, actor: "server", event: "sent_to_approval", reason: "SUBSTITUTION" },
      { at, actor: "approver", event: "approved" },
      { at, actor: "server", event: "placed" },
    ],
    createdAt: at,
  };
};

/**
 * Order history of the demo customer (SPEC-015), so scenario 1 gives no reason and scenario 2 only
 * the spend limit: three rows of the scenario 1 quantity, three of a fifth of the larger requests.
 * With a scenario 3 substitute, two approved orders of it, so the demo's approval is the third.
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
  const substitute = demo.s3 === null ? null : (demo.s3Substitute ?? null);
  if (demo.s3 !== null && substitute !== null) {
    const { productId: replaces, quantity } = demo.s3;
    // History, so the substitute is not a new product, and two approvals of the pair.
    rows.push(...times(EARLIER_APPROVALS, substitute.productId, fifth(quantity)));
    const store = postgresOrderStore(db);
    await store.withCustomerLock(DEMO_ACCOUNT.customer, async (tx) => {
      for (let index = 1; index <= EARLIER_APPROVALS; index++)
        await tx.insert(approvedSubstitute(demo, replaces, substitute.productId, index));
    });
  }
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
