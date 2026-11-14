import { SQL } from "bun";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactsResultSchema } from "@app/contract";
import { ok } from "@app/kernel";
import { closeDb, type Db, env, openDb } from "@app/server-kit";
import { sql } from "drizzle-orm";
import { createApi } from "./index.ts";
import { catalogAdapters } from "./adapters.ts";
import {
  importCatalogue,
  loadCatalogProducts,
  migrateCatalogue,
  readDemoProducts,
} from "../infra/catalog-store.ts";
import { csvRows, manifest, products } from "../infra/schema.ts";
import { DATA_FILES } from "../infra/source.ts";
import { failureOf, fictionalProducts, writeFictionalSources } from "../infra/test-fixtures.ts";

async function withDatabase(run: (db: Db, dir: string) => Promise<void>) {
  const url = env("TEST_DATABASE_URL");
  if (url === undefined) throw new Error("TEST_DATABASE_URL is required");
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.search !== "")
    throw new Error("Test database must be local");
  const name = `test_catalog_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(url);
  const dir = await mkdtemp(join(tmpdir(), "catalog-source-"));
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    parsed.pathname = `/${name}`;
    const db = openDb(parsed.toString());
    try {
      await migrateCatalogue(db);
      await writeFictionalSources(dir);
      await run(db, dir);
    } finally {
      await closeDb(db);
      await admin.unsafe(`DROP DATABASE "${name}"`);
    }
  } finally {
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const makeApp = (db: Db) =>
  createApi({ ...catalogAdapters(db), mandates: { current: async () => ok(null) } });

test("import preserves records, CSV cells and order, metadata, and exact-byte identity", async () =>
  withDatabase(async (db, dir) => {
    const report = await importCatalogue(db, dir);
    expect(report.imported).toBe(true);
    expect(report.counts).toEqual({ products: 2, reliability: 4, co2: 2 });
    expect((await db.select().from(products)).map((row) => row.record)).toEqual(fictionalProducts);
    const stored = await db.$client<
      { kind: string; id: string }[]
    >`SELECT jsonb_typeof(record) AS kind, record->>'id' AS id FROM catalog_products ORDER BY ordinal`;
    expect(stored.map((row) => [row.kind, row.id])).toEqual([
      ["object", "fictional-oats"],
      ["object", "fictional-milk"],
    ]);
    const [sourceTypes] =
      await db.$client`SELECT jsonb_typeof(checksums) AS checksums, jsonb_typeof(counts) AS counts, jsonb_typeof("sourceSchema") AS schema, jsonb_typeof("demoProducts") AS demo FROM catalog_manifest`;
    expect(sourceTypes).toEqual({
      checksums: "object",
      counts: "object",
      schema: "object",
      demo: "object",
    });
    expect(
      (
        await db.$client<
          { kind: string }[]
        >`SELECT DISTINCT jsonb_typeof(cells) AS kind FROM catalog_csv_rows`
      ).map((row) => row.kind),
    ).toEqual(["array"]);
    const rows = await db.select().from(csvRows);
    expect(rows.filter((row) => row.source === "reliability").map((row) => row.cells)).toEqual([
      ["fictional-oats", "0.95"],
      ["fictional-milk", ""],
      ["orphan", "0.5"],
      ["", ""],
    ]);
    expect((await db.select().from(manifest))[0]?.sourceSchema).toEqual(
      JSON.parse(await readFile(join(dir, DATA_FILES.schema), "utf8")),
    );
    const projected = await loadCatalogProducts(db);
    expect(projected.map((product) => [product.productId, product.deliveryReliability])).toEqual([
      ["fictional-oats", 0.95],
      ["fictional-milk", null],
    ]);
    expect((await readDemoProducts(db))?.s1.productId).toBe("fictional-oats");
    expect((await importCatalogue(db, dir)).imported).toBe(false);
    const file = join(dir, DATA_FILES.demo);
    await writeFile(file, `${await readFile(file, "utf8")} `);
    expect(await failureOf(importCatalogue(db, dir))).toContain("different catalogue");
    expect((await db.select().from(products)).length).toBe(2);
  }));

test("invalid input and insertion failures do not leave partial data", async () =>
  withDatabase(async (db, dir) => {
    const reliability = join(dir, DATA_FILES.reliability);
    const valid = await readFile(reliability, "utf8");
    await writeFile(reliability, `${valid}fictional-oats,0.2\n`);
    expect(await failureOf(importCatalogue(db, dir))).toContain("Duplicate");
    await writeFile(reliability, valid.replace("0.95", "1.5"));
    expect(await failureOf(importCatalogue(db, dir))).toContain("Invalid CSV value");
    await writeFile(reliability, valid);
    await db.execute(
      sql`create function catalog_reject() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`,
    );
    await db.execute(
      sql`create trigger catalog_reject before insert on catalog_products for each row execute function catalog_reject()`,
    );
    expect(await failureOf(importCatalogue(db, dir))).not.toBeNull();
    expect(await db.select().from(manifest)).toEqual([]);
    expect(await db.select().from(products)).toEqual([]);
    expect(await db.select().from(csvRows)).toEqual([]);
    await db.execute(sql`drop trigger catalog_reject on catalog_products`);
    expect((await importCatalogue(db, dir)).imported).toBe(true);
  }));

test("concurrent importer fails the advisory try-lock", async () =>
  withDatabase(async (db, dir) => {
    const locked = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();
    const transaction = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1948242190, 251)`);
      locked.resolve();
      await hold.promise;
    });
    await locked.promise;
    try {
      expect(await failureOf(importCatalogue(db, dir))).toContain("in progress");
    } finally {
      hold.resolve();
      await transaction;
    }
  }));

test("unimported API returns 502 and recovers after import; databases stay isolated", async () =>
  withDatabase(async (first, firstDir) =>
    withDatabase(async (second, secondDir) => {
      const firstApp = makeApp(first),
        secondApp = makeApp(second);
      const search = (app: ReturnType<typeof makeApp>) =>
        app.handle(
          new Request("http://localhost/catalog/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              terms: ["oats"],
              hard: [],
              soft: [],
              quantity: { value: 1, unit: "KGM" },
              deliverBy: "2026-11-16",
              paymentTerms: "invoice",
            }),
          }),
        );
      expect((await search(firstApp)).status).toBe(502);
      await importCatalogue(first, firstDir);
      expect((await search(firstApp)).status).toBe(200);
      const factsResponse = await firstApp.handle(
        new Request("http://localhost/catalog/facts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productIds: ["fictional-oats", "not-imported"], hard: [] }),
        }),
      );
      expect(factsResponse.status).toBe(200);
      const facts = FactsResultSchema.parse(await factsResponse.json());
      expect(facts.unknown).toEqual(["not-imported"]);
      expect(facts.products).toMatchObject([
        {
          productId: "fictional-oats",
          deliveryReliability: 0.95,
          co2PerKg: 1.25,
        },
      ]);
      expect((await search(secondApp)).status).toBe(502);
      await importCatalogue(second, secondDir);
      expect((await search(secondApp)).status).toBe(200);
    }),
  ));

test("schema and duplicate IDs reject the complete bundle; absent metadata is an identity", async () =>
  withDatabase(async (db, dir) => {
    const productFile = join(dir, DATA_FILES.products);
    await writeFile(productFile, JSON.stringify([fictionalProducts[0], fictionalProducts[0]]));
    expect(await failureOf(importCatalogue(db, dir))).toContain("Duplicate product ID");
    await writeFile(
      productFile,
      JSON.stringify([{ ...fictionalProducts[0], synkkaData: "invalid" }]),
    );
    expect(await failureOf(importCatalogue(db, dir))).not.toBeNull();
    await writeFile(productFile, JSON.stringify(fictionalProducts));
    await rm(join(dir, DATA_FILES.demo));
    expect((await importCatalogue(db, dir)).imported).toBe(true);
    expect(await readDemoProducts(db)).toBeNull();
    await writeFictionalSources(dir);
    expect(await failureOf(importCatalogue(db, dir))).toContain("different catalogue");
  }));

test("unmanifested data is a conflict, not permission to overwrite", async () =>
  withDatabase(async (db, dir) => {
    await db
      .insert(products)
      .values({ ordinal: 0, productId: "previous-record", record: { preserved: true } });
    expect(await failureOf(importCatalogue(db, dir))).toContain("Unmanifested");
    expect(await db.select().from(manifest)).toEqual([]);
    expect((await db.select().from(products)).map((row) => row.record)).toEqual([
      { preserved: true },
    ]);
  }));
