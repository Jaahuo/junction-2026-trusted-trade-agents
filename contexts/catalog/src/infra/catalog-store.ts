import { resolve } from "node:path";
import type { DemoProducts } from "@app/contract";
import { contextsDir, type Db } from "@app/server-kit";
import { asc, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { CatalogProduct } from "../domain/catalog.ts";
import { RawProductSchema, toProduct } from "./projection.ts";
import { csvRows, manifest, products } from "./schema.ts";
import { readSource } from "./source.ts";

// Bind text before casting: Bun otherwise JSON-encodes Drizzle's serialized JSON a second time.
const jsonbValue = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;

export const migrateCatalogue = (db: Db): Promise<void> =>
  migrate(db, {
    migrationsFolder: resolve(contextsDir, "catalog/migrations"),
    migrationsTable: "__migrations_catalog",
  });

export async function readDemoProducts(db: Db): Promise<DemoProducts | null> {
  const rows = await db.select().from(manifest);
  return rows[0]?.demoProducts ?? null;
}

export async function loadCatalogProducts(db: Db): Promise<CatalogProduct[]> {
  const manifests = await db.select().from(manifest);
  if (manifests.length !== 1) throw new Error("Catalogue has not been imported");
  const records = await db.select().from(products).orderBy(asc(products.ordinal));
  const rows = await db.select().from(csvRows).orderBy(asc(csvRows.ordinal));
  const reliability = new Map<string, number>(),
    co2 = new Map<string, number>();
  for (const row of rows) {
    const [id, value] = row.cells;
    if (id !== undefined && id !== "" && value !== undefined && value.trim() !== "")
      (row.source === "reliability" ? reliability : co2).set(id, Number(value));
  }
  return records.map(({ record }) => toProduct(RawProductSchema.parse(record), reliability, co2));
}

export async function importCatalogue(db: Db, sourceDir: string) {
  const source = await readSource(sourceDir);
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(1948242190, 251) as locked`,
    );
    if (!lock[0]?.["locked"]) throw new Error("Another catalogue import is in progress");
    const existing = await tx.select().from(manifest);
    if (existing.length > 0) {
      const current = existing[0];
      if (
        existing.length !== 1 ||
        current === undefined ||
        Object.keys(source.checksums).some(
          (key) => current.checksums[key] !== source.checksums[key],
        )
      )
        throw new Error("A different catalogue is already imported");
      return { imported: false, checksums: source.checksums, counts: source.counts };
    }
    const [productCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(products);
    const [csvCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(csvRows);
    if (productCount?.count !== 0 || csvCount?.count !== 0)
      throw new Error("Unmanifested catalogue tables are not empty");
    await tx.insert(manifest).values({
      id: 1,
      checksums: jsonbValue(source.checksums),
      counts: jsonbValue(source.counts),
      sourceSchema: jsonbValue(source.sourceSchema),
      demoProducts: source.demoProducts === null ? null : jsonbValue(source.demoProducts),
    });
    for (let i = 0; i < source.productRows.length; i += 500)
      await tx.insert(products).values(
        source.productRows.slice(i, i + 500).map((row) => ({
          ordinal: row.ordinal,
          productId: row.productId,
          record: jsonbValue(row.record),
        })),
      );
    for (const [name, rows] of [
      ["reliability", source.reliability],
      ["co2", source.co2],
    ] as const) {
      for (let i = 0; i < rows.length; i += 500)
        await tx.insert(csvRows).values(
          rows.slice(i, i + 500).map((cells, index) => ({
            source: name,
            ordinal: i + index,
            cells: jsonbValue(cells),
          })),
        );
    }
    return { imported: true, checksums: source.checksums, counts: source.counts };
  });
}
