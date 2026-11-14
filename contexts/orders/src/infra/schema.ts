import type { AuditEvent, Order, OrderLine, Quantity, ReasonCode } from "@app/contract";
import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const orders = pgTable(
  "orders_orders",
  {
    orderId: text().primaryKey(),
    customer: text().notNull(),
    agentId: text().notNull(),
    accountId: text().notNull(),
    idempotencyKey: text().notNull(),
    /** The tokens of the request, to tell a replay from a conflicting reuse of the key. */
    requested: jsonb().$type<{ offers: string[]; alternatives: string[] }>().notNull(),
    lines: jsonb().$type<OrderLine[]>().notNull(),
    alternatives: jsonb().$type<OrderLine[]>().notNull(),
    mandateId: text(),
    mandateVersion: integer(),
    status: text({
      enum: ["pending_approval", "awaiting_payment", "placed", "rejected", "declined"],
    }).notNull(),
    reasons: jsonb().$type<ReasonCode[]>().notNull(),
    proposalVersion: integer().notNull(),
    paymentTerms: text({ enum: ["invoice", "pay_on_order"] }).notNull(),
    totalNet: doublePrecision().notNull(),
    totalGross: doublePrecision().notNull(),
    originalRequest: text(),
    decision: jsonb().$type<Order["decision"]>(),
    requotes: jsonb().$type<Order["requotes"]>().notNull(),
    nextDeliveryDate: text(),
    audit: jsonb().$type<AuditEvent[]>().notNull(),
    receipt: text(),
    auditAnchor: jsonb().$type<NonNullable<Order["auditAnchor"]>>(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("orders_orders_customer_idempotency_key").on(table.customer, table.idempotencyKey),
    index("orders_orders_lines_offer_ids").using(
      "gin",
      sql`((${table.lines} #>> '{}')::jsonb) jsonb_path_ops`,
    ),
  ],
);

/** Refused requests (SPEC-009 R3-R6): no order exists, so they belong to no order's audit. */
export const refusals = pgTable("orders_refusals", {
  id: serial().primaryKey(),
  customer: text().notNull(),
  event: jsonb().$type<AuditEvent>().notNull(),
});

/** One row per placed line, plus demo seed rows (SPEC-010). Quantities in sales units. */
export const history = pgTable("orders_history", {
  id: serial().primaryKey(),
  customer: text().notNull(),
  productId: text().notNull(),
  quantity: jsonb().$type<Quantity>().notNull(),
  placedAt: timestamp({ withTimezone: true }).notNull(),
});
