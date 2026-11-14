import {
  closeDb,
  type ContextModule,
  type Db,
  discoverContexts,
  env,
  mountContext,
  openDb,
} from "@app/server-kit";

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const ownedByContext = (names: readonly string[]) => (object: string) =>
  names.some((name) => object.startsWith(`${name.replaceAll("-", "_")}_`));

/**
 * Drops only the tables, enum types and migration records of the given contexts.
 * A hosted database keeps objects that are not ours in `public`, such as the TimescaleDB extension.
 */
const dropContextObjects = async (db: Db, names: readonly string[]): Promise<void> => {
  const ours = ownedByContext(names);
  const tables: { name: string }[] = await db.$client`
    SELECT tablename AS name FROM pg_tables
    WHERE schemaname = 'public' AND tableowner = current_user`;
  const types: { name: string }[] = await db.$client`
    SELECT t.typname AS name FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e' AND pg_get_userbyid(t.typowner) = current_user`;
  for (const table of tables.map(({ name }) => name).filter(ours))
    await db.$client.unsafe(`DROP TABLE IF EXISTS public.${quote(table)} CASCADE`);
  for (const type of types.map(({ name }) => name).filter(ours))
    await db.$client.unsafe(`DROP TYPE IF EXISTS public.${quote(type)} CASCADE`);
  for (const name of names)
    await db.$client.unsafe(`DROP TABLE IF EXISTS drizzle.${quote(`__migrations_${name}`)}`);
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
