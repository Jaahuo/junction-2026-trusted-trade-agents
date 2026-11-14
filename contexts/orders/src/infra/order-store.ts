import type { Db } from "@app/server-kit";
import { and, eq, inArray, sql, sum } from "drizzle-orm";
import type { OrderStore, OrderTx, StoredOrder } from "../application/ports.ts";
import { history, orders, refusals } from "./schema.ts";

type Row = typeof orders.$inferSelect;
type Executor = Pick<Db, "select" | "insert" | "update">;

const toStored = (row: Row): StoredOrder => ({
  orderId: row.orderId,
  customer: row.customer,
  agentId: row.agentId,
  accountId: row.accountId,
  idempotencyKey: row.idempotencyKey,
  requested: row.requested,
  offerIds: row.lines.map((line) => line.offerId),
  lines: row.lines,
  alternatives: row.alternatives,
  mandateId: row.mandateId,
  mandateVersion: row.mandateVersion,
  status: row.status,
  reasons: row.reasons,
  proposalVersion: row.proposalVersion,
  paymentTerms: row.paymentTerms,
  total: { net: row.totalNet, gross: row.totalGross },
  originalRequest: row.originalRequest,
  decision: row.decision,
  requotes: row.requotes,
  nextDeliveryDate: row.nextDeliveryDate,
  audit: row.audit,
  createdAt: row.createdAt.toISOString(),
});

const toRow = (order: StoredOrder): Row => ({
  orderId: order.orderId,
  customer: order.customer,
  agentId: order.agentId,
  accountId: order.accountId,
  idempotencyKey: order.idempotencyKey,
  requested: order.requested,
  lines: order.lines,
  alternatives: order.alternatives,
  mandateId: order.mandateId,
  mandateVersion: order.mandateVersion,
  status: order.status,
  reasons: order.reasons,
  proposalVersion: order.proposalVersion,
  paymentTerms: order.paymentTerms,
  totalNet: order.total.net,
  totalGross: order.total.gross,
  originalRequest: order.originalRequest,
  decision: order.decision,
  requotes: order.requotes,
  nextDeliveryDate: order.nextDeliveryDate,
  audit: order.audit,
  createdAt: new Date(order.createdAt),
});

const findByKey = async (db: Executor, customer: string, idempotencyKey: string) => {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.customer, customer), eq(orders.idempotencyKey, idempotencyKey)));
  return row === undefined ? null : toStored(row);
};

const orderTx = (tx: Executor): OrderTx => ({
  findByKey: (customer, key) => findByKey(tx, customer, key),
  insert: async (order) => {
    await tx.insert(orders).values(toRow(order));
  },
  update: async (order) => {
    await tx.update(orders).set(toRow(order)).where(eq(orders.orderId, order.orderId));
  },
  placedInvoiceGross: async (customer) => {
    const [row] = await tx
      .select({ gross: sum(orders.totalGross).mapWith(Number) })
      .from(orders)
      .where(
        and(
          eq(orders.customer, customer),
          eq(orders.status, "placed"),
          eq(orders.paymentTerms, "invoice"),
        ),
      );
    return row?.gross ?? 0;
  },
  addHistory: async (customer, rows, placedAt) => {
    if (rows.length === 0) return;
    await tx
      .insert(history)
      .values(rows.map(({ productId, quantity }) => ({ customer, productId, quantity, placedAt })));
  },
});

export const postgresOrderStore = (db: Db): OrderStore => ({
  find: async (customer, orderId) => {
    const [row] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.customer, customer), eq(orders.orderId, orderId)));
    return row === undefined ? null : toStored(row);
  },
  findByKey: (customer, key) => findByKey(db, customer, key),
  history: async (customer, productIds) =>
    productIds.length === 0
      ? []
      : db
          .select({ productId: history.productId, quantity: history.quantity })
          .from(history)
          .where(and(eq(history.customer, customer), inArray(history.productId, productIds))),
  refuse: async (customer, event) => {
    await db.insert(refusals).values({ customer, event });
  },
  withCustomerLock: (customer, work) =>
    db.transaction(async (tx) => {
      // Serialises placement per customer, so parallel orders see each other's credit use and keys.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`orders:${customer}`}, 0))`,
      );
      return work(orderTx(tx));
    }),
});
