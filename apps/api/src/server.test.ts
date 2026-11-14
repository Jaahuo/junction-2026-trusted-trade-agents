import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { closeDb, openDb } from "@app/server-kit";
import { Elysia } from "elysia";
import { createApp } from "./server.ts";

test("a context root route answers GET /.well-known/test before the SPA fallback", async () => {
  const webDist = await mkdtemp(join(tmpdir(), "web-dist-"));
  // The test context has no migrations, so the database is never contacted.
  const db = openDb("postgres://127.0.0.1:1/unused");
  try {
    await writeFile(join(webDist, "index.html"), "<!doctype html><p>spa</p>");
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
    const spa = await app.handle(new Request("http://localhost/approvals"));
    expect(await spa.text()).toContain("spa");
  } finally {
    await closeDb(db);
    await rm(webDist, { recursive: true, force: true });
  }
});
