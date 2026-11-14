import { resolve } from "node:path";
import { closeDb, type ContextModule, type Db, env, mountContext, openDb } from "@app/server-kit";
import { Elysia } from "elysia";

/**
 * Builds the HTTP app: `/api` with every context API, then the context root routes, then the web fallback.
 * Root routes come before the fallback so that the SPA never shadows them.
 */
export const createApp = async (
  db: Db,
  contexts: readonly ContextModule[],
  webDist: string | undefined,
) => {
  const api = new Elysia({ prefix: "/api" }).get("/health", () => ({ ok: true }));
  for (const context of contexts) {
    api.use(await mountContext(db, context));
  }
  const app = new Elysia({ precompile: true }).use(api);
  for (const context of contexts) {
    if (context.root !== undefined) app.use(context.root(db));
  }
  if (webDist !== undefined) {
    const root = resolve(webDist);
    app.get("/*", async ({ path, set, status }) => {
      const file = Bun.file(resolve(root, `.${path}`));
      const isAsset = file.name?.startsWith(`${root}/`) === true && (await file.exists());
      if (!isAsset && path.startsWith("/views/")) {
        return status(404, "Not Found");
      }
      if (isAsset && path.startsWith("/assets/")) {
        set.headers["cache-control"] = "public, max-age=31536000, immutable";
      }
      return isAsset ? file : Bun.file(`${root}/index.html`);
    });
  }
  return app;
};

export const serve = async (contexts: readonly ContextModule[]): Promise<void> => {
  const databaseUrl = env("DATABASE_URL");
  const port = env("PORT");
  if (
    databaseUrl === undefined ||
    port === undefined ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  ) {
    throw new Error(
      "DATABASE_URL and a valid PORT are required. Run the runtime setup command first.",
    );
  }
  const db = openDb(databaseUrl);

  let app: Awaited<ReturnType<typeof createApp>>;
  try {
    app = await createApp(db, contexts, env("WEB_DIST"));
  } catch (error) {
    await closeDb(db);
    throw error;
  }
  app.onStop(async () => {
    await closeDb(db);
  });
  try {
    app.listen(Number(port));
  } catch (error) {
    await closeDb(db);
    throw error;
  }
  const stop = async () => {
    await app.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(`listening on http://localhost:${app.server?.port}`);
};
