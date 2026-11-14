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

export interface CurrentMandate {
  id: string;
  version: number;
  standingConstraints: Constraints;
}

export interface MandateSource {
  /** `ok(null)` when there is no current mandate or the mandates service is not built yet. */
  current(): Promise<Result<CurrentMandate | null, "UPSTREAM_FAILED">>;
}

export type CatalogLoader = () => Promise<WholesalerCatalog>;

export interface CatalogDeps {
  catalog: CatalogLoader;
  mandates: MandateSource;
}

export type SearchError = "EMPTY_TERMS" | "UPSTREAM_FAILED";

/** Loads once; parallel first calls share one load. A failed load is retried on the next call. */
export const lazyCatalog = (load: CatalogLoader): CatalogLoader => {
  let pending: Promise<WholesalerCatalog> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
};

export const searchProducts = async (
  deps: CatalogDeps,
  request: SearchRequest,
): Promise<Result<SearchResult, SearchError>> => {
  if (!parseTerms(request.terms).ok) return err("EMPTY_TERMS");
  const mandate = await deps.mandates.current();
  if (!mandate.ok) return mandate;
  const constraints = mergeConstraints(
    { hard: request.hard, soft: request.soft },
    mandate.value?.standingConstraints ?? null,
  );
  const catalog = await deps.catalog();
  return ok({
    candidates: [...catalog.searchCatalog({ ...request, ...constraints })],
    constraints,
    mandate:
      mandate.value === null ? null : { id: mandate.value.id, version: mandate.value.version },
  });
};

export const productFacts = async (
  catalog: CatalogLoader,
  request: FactsRequest,
): Promise<FactsResult> => (await catalog()).facts(request);
