import { SQL } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { AnyElysia } from "elysia";

export type Db = BunSQLDatabase & { $client: SQL };
export interface ContextModule {
  readonly name: string;
  readonly api: (db: Db) => AnyElysia;
  readonly seed?: (db: Db) => void | Promise<void>;
}

export const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

export const contextsDir = resolve(
  process.env["APP_ROOT"] ?? resolve(import.meta.dir, "../../.."),
  "contexts",
);

export const openDb = (url: string): Db => drizzle(new SQL(url));
export const closeDb = async (db: Db): Promise<void> => {
  await db.$client.close();
};

export const mountContext = async (db: Db, context: ContextModule): Promise<AnyElysia> => {
  const migrationsFolder = resolve(contextsDir, context.name, "migrations");
  if (existsSync(migrationsFolder)) {
    await migrate(db, { migrationsFolder, migrationsTable: `__migrations_${context.name}` });
  }
  return context.api(db);
};

const isContextModule = (value: unknown): value is { context: ContextModule } =>
  typeof value === "object" &&
  value !== null &&
  "context" in value &&
  typeof value.context === "object" &&
  value.context !== null &&
  "name" in value.context &&
  "api" in value.context;

export const discoverContexts = async (): Promise<ContextModule[]> => {
  const files = [...new Bun.Glob("*/src/api/index.ts").scanSync(contextsDir)].toSorted();
  return Promise.all(
    files.map(async (file) => {
      // Context modules are discovered at runtime, so their paths cannot be static imports.
      const module: unknown = await import(`${contextsDir}/${file}`);
      if (!isContextModule(module)) {
        throw new Error(`contexts/${file} must export \`context: ContextModule\``);
      }
      return module.context;
    }),
  );
};
