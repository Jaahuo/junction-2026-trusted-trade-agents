import type { Mandate } from "@app/contract";
import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const mandates = pgTable(
  "mandates_mandates",
  {
    mandateId: text().primaryKey(),
    customer: text().notNull(),
    agent: text().notNull(),
    version: integer().notNull(),
    status: text({ enum: ["active", "revoked"] }).notNull(),
    mandate: jsonb().$type<Mandate>().notNull(),
    jws: text(),
    registeredAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("mandates_mandates_owner_version").on(table.customer, table.agent, table.version),
    uniqueIndex("mandates_mandates_one_active")
      .on(table.customer, table.agent)
      .where(sql`${table.status} = 'active'`),
  ],
);
