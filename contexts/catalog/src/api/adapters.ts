import { selfBaseUrl } from "@app/server-kit";
import { type CatalogDeps, lazyCatalog } from "../application/catalog.ts";
import { createCatalog } from "../domain/catalog.ts";
import { edenMandateSource } from "../infra/mandate-client.ts";
import { defaultDataDir, loadProductFile } from "../infra/product-file.ts";

// One index per process (SPEC-004); nothing loads before the first request.
const fileCatalog = lazyCatalog(async () => createCatalog(await loadProductFile(defaultDataDir())));

/** The file catalog adapter of SPEC-005, the only one built. */
export const catalogAdapters = (): CatalogDeps => ({
  catalog: fileCatalog,
  mandates: edenMandateSource(() => `${selfBaseUrl()}/api`),
});
