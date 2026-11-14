import { type Db, selfBaseUrl } from "@app/server-kit";
import { type CatalogDeps, type CatalogSource, lazyCatalog } from "../application/catalog.ts";
import { createCatalog } from "../domain/catalog.ts";
import { loadCatalogProducts } from "../infra/catalog-store.ts";
import { edenMandateSource } from "../infra/mandate-client.ts";

const catalogs = new WeakMap<Db, CatalogSource>();

export const catalogAdapters = (db: Db): CatalogDeps => {
  let catalog = catalogs.get(db);
  if (catalog === undefined) {
    catalog = lazyCatalog(async () => createCatalog(await loadCatalogProducts(db)));
    catalogs.set(db, catalog);
  }
  return { catalog, mandates: edenMandateSource(() => `${selfBaseUrl()}/api`) };
};
