import { importCatalogue, migrateCatalogue } from "../contexts/catalog/src/api/index.ts";
import { closeDb, env, openDb } from "../packages/server-kit/src/index.ts";
import { loadRuntime } from "./runtime.ts";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--source" || args[1] === undefined)
  throw new Error("Usage: bun scripts/catalog-import.ts --source /absolute/private/directory");
if (env("DATABASE_URL") === undefined) await loadRuntime();
const url = env("DATABASE_URL");
if (url === undefined) throw new Error("DATABASE_URL is required");
const db = openDb(url);
try {
  await migrateCatalogue(db);
  console.log(JSON.stringify(await importCatalogue(db, args[1])));
} finally {
  await closeDb(db);
}
