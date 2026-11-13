import { resolve } from "node:path";
import { closeDb, type ContextModule, env, mountContext, openDb } from "@app/server-kit";
import { Elysia } from "elysia";

export const serve = async (contexts: readonly ContextModule[]): Promise<void> => {
  const webDist = env("WEB_DIST");
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

  const api = new Elysia({ prefix: "/api" }).get("/health", () => ({ ok: true }));
  try {
    for (const context of contexts) {
      api.use(await mountContext(db, context));
    }
  } catch (error) {
    await closeDb(db);
    throw error;
  }

  const app = new Elysia({ precompile: true }).use(api);
  if (webDist !== undefined) {
    const root = resolve(webDist);
    app.get("/*", async ({ path, set }) => {
      const file = Bun.file(resolve(root, `.${path}`));
      const isAsset = file.name?.startsWith(`${root}/`) === true && (await file.exists());
      if (isAsset && path.startsWith("/assets/")) {
        set.headers["cache-control"] = "public, max-age=31536000, immutable";
      }
      return isAsset ? file : Bun.file(`${root}/index.html`);
    });
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
