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
    await writeFile(
      join(webDist, "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
    );
    const app = await createApp(
      db,
      [
        {
          name: "root-route-test",
          api: () =>
            new Elysia({ prefix: "/root-route-test" }).get("/known", () => ({ api: true })),
          root: () => new Elysia().get("/.well-known/test", () => ({ root: true })),
        },
      ],
      webDist,
    );
    const root = await app.handle(new Request("http://localhost/.well-known/test"));
    expect(await root.json()).toEqual({ root: true });
    const health = await app.handle(new Request("http://localhost/api/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    const knownApi = await app.handle(new Request("http://localhost/api/root-route-test/known"));
    expect(knownApi.status).toBe(200);
    expect(await knownApi.json()).toEqual({ api: true });
    for (const path of ["/api", "/api/no-such-route", "/api/orders/no-such-route/nested"]) {
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const missing = await app.handle(new Request(`http://localhost${path}`, { method }));
        expect(missing.status).toBe(404);
        expect(missing.headers.get("content-type")).toContain("application/json");
        if (method !== "HEAD") {
          expect(await missing.json()).toEqual({
            error: { code: "NOT_FOUND", message: "Unknown API route." },
          });
        }
      }
    }
    for (const path of ["/views/missing.html", "/views/missing/nested.js"]) {
      const missing = await app.handle(new Request(`http://localhost${path}`));
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain("<!doctype html>");
    }
    for (const [path, type, content] of [
      ["/icon.svg", "image/svg+xml", "<svg"],
      ["/views/test.html", "text/html", "view bundle"],
      ["/approvals", "text/html", "spa"],
    ] as const) {
      for (const method of ["GET", "HEAD"]) {
        const response = await app.handle(new Request(`http://localhost${path}`, { method }));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(type);
        if (method === "GET") expect(await response.text()).toContain(content);
      }
    }
  } finally {
    await closeDb(db);
    await rm(webDist, { recursive: true, force: true });
  }
});
