import type { DemoProducts } from "@app/contract";
import { integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const manifest = pgTable("catalog_manifest", {
  id: integer().primaryKey(),
  checksums: jsonb().$type<Record<string, string | null>>().notNull(),
  counts: jsonb().$type<Record<string, number>>().notNull(),
  sourceSchema: jsonb().notNull(),
  demoProducts: jsonb().$type<DemoProducts>(),
});

export const products = pgTable("catalog_products", {
  ordinal: integer().primaryKey(),
  productId: text().notNull().unique(),
  record: jsonb().notNull(),
});

export const csvRows = pgTable(
  "catalog_csv_rows",
  {
    source: text().notNull(),
    ordinal: integer().notNull(),
    cells: jsonb().$type<string[]>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.source, table.ordinal] })],
);
