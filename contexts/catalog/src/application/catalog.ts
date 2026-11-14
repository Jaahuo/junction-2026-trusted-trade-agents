import type {
  FactsRequest,
  FactsResult,
  SearchRequest,
  SearchResult,
  WholesalerCatalog,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { isSupportedSoftAttribute, MAX_CANDIDATES, parseTerms } from "../domain/catalog.ts";
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

export interface AvailabilitySource {
  /** The ids, of those given, that the wholesaler can deliver on or before the date. */
  deliverable(
    deliverBy: string,
    productIds: readonly string[],
  ): Promise<Result<ReadonlySet<string>, "UPSTREAM_FAILED">>;
}

export interface CatalogDeps {
  catalog: CatalogSource;
  mandates: MandateSource;
  availability: AvailabilitySource;
}

/** Ranked matches read before the availability filter, so that lower-ranked matches fill the 20 places. */
export const SEARCH_POOL = 60;

export type SearchError =
  | "EMPTY_TERMS"
  | "INVALID_QUANTITY"
  | "UNSUPPORTED_SOFT_ATTRIBUTE"
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
  if (request.soft.some(({ attribute }) => !isSupportedSoftAttribute(attribute)))
    return err("UNSUPPORTED_SOFT_ATTRIBUTE");
  const mandate = await deps.mandates.current();
  if (!mandate.ok) return mandate;
  const constraints = mergeConstraints(
    { hard: request.hard, soft: request.soft },
    mandate.value?.standingConstraints ?? null,
  );
  if (constraints.soft.some(({ attribute }) => !isSupportedSoftAttribute(attribute)))
    return err("UNSUPPORTED_SOFT_ATTRIBUTE");
  const catalog = await deps.catalog();
  if (!catalog.ok) return catalog;
  const pool = catalog.value.searchCatalog({ ...request, ...constraints }, SEARCH_POOL);
  // A failed availability read keeps the search usable: the offers step reads availability again.
  const deliverable =
    pool.length === 0
      ? null
      : await deps.availability.deliverable(
          request.deliverBy,
          pool.map((candidate) => candidate.productId),
        );
  const checked = deliverable === null || deliverable.ok;
  const kept =
    deliverable?.ok === true
      ? pool.filter((candidate) => deliverable.value.has(candidate.productId))
      : pool;
  return ok({
    candidates: kept.slice(0, MAX_CANDIDATES),
    availability: { checked, dropped: pool.length - kept.length },
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
