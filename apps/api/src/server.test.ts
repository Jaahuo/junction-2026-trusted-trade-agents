import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { closeDb, openDb } from "@app/server-kit";
import { Elysia } from "elysia";
import { createApp } from "./server.ts";

test("production fallback preserves root routes and serves the SPA only for app routes", async () => {
  const webDist = await mkdtemp(join(tmpdir(), "web-dist-"));
  // The test context has no migrations, so the database is never contacted.
  const db = openDb("postgres://127.0.0.1:1/unused");
  try {
    await writeFile(join(webDist, "index.html"), "<!doctype html><p>spa</p>");
    await mkdir(join(webDist, "views"));
    await writeFile(join(webDist, "views", "test.html"), "<!doctype html><p>view bundle</p>");
    const app = await createApp(
      db,
      [
        {
          name: "root-route-test",
          api: () => new Elysia({ prefix: "/root-route-test" }),
          root: () => new Elysia().get("/.well-known/test", () => ({ root: true })),
        },
      ],
      webDist,
    );
    const root = await app.handle(new Request("http://localhost/.well-known/test"));
    expect(await root.json()).toEqual({ root: true });
    for (const path of ["/views/missing.html", "/views/missing/nested.js"]) {
      const missing = await app.handle(new Request(`http://localhost${path}`));
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain("<!doctype html>");
    }
    const view = await app.handle(new Request("http://localhost/views/test.html"));
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("view bundle");
    const spa = await app.handle(new Request("http://localhost/approvals"));
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("spa");
  } finally {
    await closeDb(db);
    await rm(webDist, { recursive: true, force: true });
  }
});
