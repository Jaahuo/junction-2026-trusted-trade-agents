import type { Db } from "@app/server-kit";
import { appendAudit, verifyAuditChain } from "@app/contract/server";
import { err, ok } from "@app/kernel";
import { and, asc, eq, inArray, or, sql, sum } from "drizzle-orm";
import type { OrderStore, OrderTx, StoredOrder } from "../application/ports.ts";
import { history, orders, refusalAnchors, refusals } from "./schema.ts";

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
  ...(row.receipt === null ? {} : { receipt: row.receipt }),
  ...(row.auditAnchor === null ? {} : { auditAnchor: row.auditAnchor }),
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
  receipt: order.receipt ?? null,
  auditAnchor: order.auditAnchor ?? null,
  createdAt: new Date(order.createdAt),
});

const find = async (db: Executor, customer: string, orderId: string) => {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.customer, customer), eq(orders.orderId, orderId)));
  return row === undefined ? null : toStored(row);
};

const findByKey = async (db: Executor, customer: string, idempotencyKey: string) => {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.customer, customer), eq(orders.idempotencyKey, idempotencyKey)));
  return row === undefined ? null : toStored(row);
};

const orderTx = (tx: Executor): OrderTx => ({
  find: (customer, orderId) => find(tx, customer, orderId),
  findByKey: (customer, key) => findByKey(tx, customer, key),
  hasUsedOffers: async (customer, offerIds) => {
    if (offerIds.length === 0) return false;
    const rows = await tx
      .select({ orderId: orders.orderId })
      .from(orders)
      .where(
        and(
          eq(orders.customer, customer),
          // A line's offer, or one an approver's edit or pick replaced: both stay consumed (SPEC-009).
          or(
            ...offerIds.flatMap((offerId) => [
              sql`(${orders.lines} #>> '{}')::jsonb @> jsonb_build_array(jsonb_build_object('offerId', ${offerId}::text))`,
              sql`(${orders.requotes} #>> '{}')::jsonb @> jsonb_build_array(jsonb_build_object('previous', jsonb_build_object('offerId', ${offerId}::text)))`,
            ]),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },
  insert: async (order) => {
    await tx.insert(orders).values(toRow(order));
  },
  decide: async (order, proposalVersion) => {
    const updated = await tx
      .update(orders)
      .set(toRow(order))
      .where(
        and(
          eq(orders.customer, order.customer),
          eq(orders.orderId, order.orderId),
          eq(orders.status, "pending_approval"),
          eq(orders.proposalVersion, proposalVersion),
        ),
      )
      .returning({ orderId: orders.orderId });
    return updated.length === 1;
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
  find: (customer, orderId) => find(db, customer, orderId),
  pending: async (customer) =>
    (
      await db
        .select()
        .from(orders)
        .where(and(eq(orders.customer, customer), eq(orders.status, "pending_approval")))
        .orderBy(asc(orders.createdAt))
    ).map(toStored),
  expiredPending: async (now, customer) =>
    (
      await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.status, "pending_approval"),
            customer === undefined ? undefined : eq(orders.customer, customer),
            sql`exists (
              select 1 from jsonb_array_elements((${orders.lines} #>> '{}')::jsonb) as line
              where line->'claims'->>'cutoffAt' is not null
                and (line->'claims'->>'cutoffAt')::timestamptz <= ${now.toISOString()}::timestamptz
            )`,
          ),
        )
        .orderBy(asc(orders.createdAt), asc(orders.orderId))
    ).map(toStored),
  findByKey: (customer, key) => findByKey(db, customer, key),
  history: async (customer, productIds) =>
    productIds.length === 0
      ? []
      : db
          .select({ productId: history.productId, quantity: history.quantity })
          .from(history)
          .where(and(eq(history.customer, customer), inArray(history.productId, productIds))),
  refuse: async (customer, event) => {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`orders:${customer}`}, 0))`,
      );
      const [anchor] = await tx
        .select({ hash: refusalAnchors.hash, count: refusalAnchors.count })
        .from(refusalAnchors)
        .where(eq(refusalAnchors.customer, customer));
      const rows = await tx
        .select({ event: refusals.event })
        .from(refusals)
        .where(eq(refusals.customer, customer))
        .orderBy(asc(refusals.id));
      const scope = `refusals:${customer}`;
      const events = rows.map((row) => row.event);
      if (anchor) {
        if (anchor.count !== events.length || !(await verifyAuditChain(scope, events, anchor)).ok)
          return err("AUDIT_INVALID" as const);
      } else if (events.length > 0) {
        return err("AUDIT_INVALID" as const);
      }
      const chained = await appendAudit(scope, events, [event]);
      if (!chained.ok) return err("AUDIT_INVALID" as const);
      const appended = chained.value[chained.value.length - 1];
      if (appended?.hash === undefined) return err("AUDIT_INVALID" as const);
      await tx.insert(refusals).values({ customer, event: appended });
      await tx
        .insert(refusalAnchors)
        .values({ customer, hash: appended.hash, count: chained.value.length })
        .onConflictDoUpdate({
          target: refusalAnchors.customer,
          set: { hash: appended.hash, count: chained.value.length },
        });
      return ok(undefined);
    });
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
