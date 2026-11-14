import { closeDb, discoverContexts, openDb } from "@app/server-kit";
import { currentDatabase, loadRuntime } from "../../../scripts/runtime.ts";
import { resetContexts } from "./remote-reset.ts";

const { url } = await currentDatabase();
await loadRuntime();
const db = openDb(url);
try {
  await resetContexts(db, await discoverContexts());
} finally {
  await closeDb(db);
}
