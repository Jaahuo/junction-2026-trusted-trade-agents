import { env, selfBaseUrl } from "@app/server-kit";
import { type CatalogDeps, lazyCatalog } from "../application/catalog.ts";
import { createCatalog } from "../domain/catalog.ts";
import { edenMandateSource } from "../infra/mandate-client.ts";
import { defaultDataDir, loadProductFile } from "../infra/product-file.ts";

// One index per process (SPEC-004); nothing loads before the first request.
const fileCatalog = lazyCatalog(async () => createCatalog(await loadProductFile(defaultDataDir())));

/** Adapter choice of SPEC-005: `WHOLESALER_CATALOG=file` (default). */
export const catalogAdapters = (): CatalogDeps => {
  const choice = env("WHOLESALER_CATALOG") ?? "file";
  if (choice !== "file")
    throw new Error(`WHOLESALER_CATALOG=${choice} is not supported; use file.`);
  return { catalog: fileCatalog, mandates: edenMandateSource(() => `${selfBaseUrl()}/api`) };
};
