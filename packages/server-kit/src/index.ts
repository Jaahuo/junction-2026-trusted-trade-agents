import { SQL } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { type AnyElysia, Elysia, ParseError, ValidationError } from "elysia";

export type Db = BunSQLDatabase & { $client: SQL };
export interface ContextModule {
  readonly name: string;
  readonly api: (db: Db) => AnyElysia;
  /** Root routes, mounted after `/api` and before the web fallback. */
  readonly root?: (db: Db) => AnyElysia;
  readonly seed?: (db: Db) => void | Promise<void>;
}

export const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/** The base URL a server uses to call its own routes: `INTERNAL_BASE_URL`, else `http://127.0.0.1:$PORT`. */
export const selfBaseUrl = (): string => {
  const internal = env("INTERNAL_BASE_URL");
  if (internal !== undefined) return withoutTrailingSlash(internal);
  const port = env("PORT");
  if (port === undefined) throw new Error("Set PORT or INTERNAL_BASE_URL.");
  return `http://127.0.0.1:${port}`;
};

/** The base URL that clients outside the server see: `PUBLIC_BASE_URL`, else `selfBaseUrl()`. */
export const publicBaseUrl = (): string => {
  const value = env("PUBLIC_BASE_URL");
  return value === undefined ? selfBaseUrl() : withoutTrailingSlash(value);
};

const issueMessage = (issue: unknown): string | undefined => {
  if (typeof issue !== "object" || issue === null || !("message" in issue)) return undefined;
  if (typeof issue.message !== "string") return undefined;
  const path =
    "path" in issue && Array.isArray(issue.path) && issue.path.length > 0
      ? `${issue.path.join(".")}: `
      : "";
  return `${path}${issue.message}`;
};

/** Maps request validation and parse failures of a context's routes to `400 BAD_REQUEST` in the contract's error envelope. */
export const badRequestEnvelope = () =>
  new Elysia().onError("plugin", ({ error, set }) => {
    const invalidRequest = error instanceof ValidationError && error.status === 422;
    if (!invalidRequest && !(error instanceof ParseError)) return undefined;
    set.status = 400;
    const issues: unknown[] = invalidRequest ? error.all : [];
    const message = issueMessage(issues[0]) ?? "The request body is not valid JSON.";
    return { error: { code: "BAD_REQUEST" as const, message } };
  });

/** The body of a stub route until its context issue replaces it. */
export const notImplemented = (route: string) => ({
  error: { code: "NOT_IMPLEMENTED" as const, message: `${route} is not implemented yet.` },
});

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
