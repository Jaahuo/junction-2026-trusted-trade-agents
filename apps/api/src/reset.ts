import { closeDb, discoverContexts, mountContext, openDb } from "@app/server-kit";
import { sql } from "drizzle-orm";
import { currentDatabase, loadRuntime } from "../../../scripts/runtime.ts";

const { url } = await currentDatabase();
await loadRuntime();
const db = openDb(url);
try {
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  for (const context of await discoverContexts()) {
    await mountContext(db, context);
    await context.seed?.(db);
    console.log(
      `reset ${context.name}${context.seed === undefined ? "" : " and loaded demo data"}`,
    );
  }
} finally {
  await closeDb(db);
}
