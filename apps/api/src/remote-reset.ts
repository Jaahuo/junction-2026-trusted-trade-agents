import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  closeDb,
  type ContextModule,
  contextsDir,
  type Db,
  discoverContexts,
  env,
  mountContext,
  openDb,
} from "@app/server-kit";

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const list = (objects: readonly string[]): string =>
  objects.map((object) => `public.${quote(object)}`).join(", ");

const CREATED = /CREATE (TABLE|TYPE) (?:IF NOT EXISTS )?(?:"public"\.)?"([^"]+)"/g;

/** The tables and types that a context's own migrations create: the exact set a reset may drop. */
export const migrationManifest = async (
  name: string,
): Promise<{ tables: string[]; types: string[] }> => {
  const dir = resolve(contextsDir, name, "migrations");
  const tables: string[] = [];
  const types: string[] = [];
  if (!existsSync(dir)) return { tables, types };
  for (const file of [...new Bun.Glob("*.sql").scanSync(dir)].toSorted())
    for (const [, kind, object] of (await Bun.file(resolve(dir, file)).text()).matchAll(CREATED))
      if (object !== undefined) (kind === "TABLE" ? tables : types).push(object);
  return { tables, types };
};

/**
 * Drops only what the contexts' migrations created, without CASCADE, in one transaction.
 * A hosted database keeps objects that are not ours in `public`, such as the TimescaleDB extension;
 * a foreign object that depends on ours aborts the reset before anything is dropped.
 */
const dropContextObjects = async (db: Db, names: readonly string[]): Promise<void> => {
  const manifests = await Promise.all(names.map(migrationManifest));
  const tables = manifests.flatMap((manifest) => manifest.tables);
  const types = manifests.flatMap((manifest) => manifest.types);
  await db.$client.begin(async (tx) => {
    if (tables.length > 0) await tx.unsafe(`DROP TABLE IF EXISTS ${list(tables)}`);
    if (types.length > 0) await tx.unsafe(`DROP TYPE IF EXISTS ${list(types)}`);
    for (const name of names)
      await tx.unsafe(`DROP TABLE IF EXISTS drizzle.${quote(`__migrations_${name}`)}`);
  });
};

export const resetContexts = async (db: Db, contexts: readonly ContextModule[]): Promise<void> => {
  await dropContextObjects(
    db,
    contexts.map((context) => context.name),
  );
  for (const context of contexts) {
    await mountContext(db, context);
    await context.seed?.(db);
    console.log(
      `reset ${context.name}${context.seed === undefined ? "" : " and loaded demo data"}`,
    );
  }
};

if (import.meta.main) {
  const url = env("DATABASE_URL");
  if (url === undefined || !process.argv.includes("--yes"))
    throw new Error("Set DATABASE_URL to the hosted database and pass --yes to reset it.");
  const db = openDb(url);
  try {
    await resetContexts(db, await discoverContexts());
  } finally {
    await closeDb(db);
  }
}
