import type {
  FactsRequest,
  FactsResult,
  SearchRequest,
  SearchResult,
  WholesalerCatalog,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { parseTerms } from "../domain/catalog.ts";
import { type Constraints, mergeConstraints } from "../domain/match.ts";
import { isValidQuantity } from "../domain/quantity.ts";

export interface CurrentMandate {
  id: string;
  version: number;
  standingConstraints: Constraints;
}

export interface MandateSource {
  /** `ok(null)` when there is no current mandate or the mandates service is not built yet. */
  current(): Promise<Result<CurrentMandate | null, "UPSTREAM_FAILED">>;
}

/** Reads the product data; throws when it cannot. */
export type CatalogLoader = () => Promise<WholesalerCatalog>;

export type CatalogSource = () => Promise<Result<WholesalerCatalog, "CATALOG_UNAVAILABLE">>;

export interface CatalogDeps {
  catalog: CatalogSource;
  mandates: MandateSource;
}

export type SearchError =
  | "EMPTY_TERMS"
  | "INVALID_QUANTITY"
  | "UPSTREAM_FAILED"
  | "CATALOG_UNAVAILABLE";

/** Loads once; parallel first calls share one load. A failed load gives an error and is retried on the next call. */
export const lazyCatalog = (load: CatalogLoader): CatalogSource => {
  let pending: Promise<Result<WholesalerCatalog, "CATALOG_UNAVAILABLE">> | undefined;
  return () => {
    pending ??= load().then(ok, (error: unknown) => {
      console.error(`catalog: product index load failed: ${String(error)}`);
      pending = undefined;
      return err("CATALOG_UNAVAILABLE" as const);
    });
    return pending;
  };
};

export const searchProducts = async (
  deps: CatalogDeps,
  request: SearchRequest,
): Promise<Result<SearchResult, SearchError>> => {
  if (!parseTerms(request.terms).ok) return err("EMPTY_TERMS");
  if (!isValidQuantity(request.quantity)) return err("INVALID_QUANTITY");
  const mandate = await deps.mandates.current();
  if (!mandate.ok) return mandate;
  const constraints = mergeConstraints(
    { hard: request.hard, soft: request.soft },
    mandate.value?.standingConstraints ?? null,
  );
  const catalog = await deps.catalog();
  if (!catalog.ok) return catalog;
  return ok({
    candidates: [...catalog.value.searchCatalog({ ...request, ...constraints })],
    constraints,
    mandate:
      mandate.value === null ? null : { id: mandate.value.id, version: mandate.value.version },
  });
};

export const productFacts = async (
  source: CatalogSource,
  request: FactsRequest,
): Promise<Result<FactsResult, "CATALOG_UNAVAILABLE">> => {
  const catalog = await source();
  return catalog.ok ? ok(catalog.value.facts(request)) : catalog;
};
