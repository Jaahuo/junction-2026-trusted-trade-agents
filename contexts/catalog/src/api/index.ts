import {
  type ErrorCode,
  ErrorEnvelopeSchema,
  FactsRequestSchema,
  FactsResultSchema,
  SearchRequestSchema,
  SearchResultSchema,
} from "@app/contract";
import { badRequestEnvelope, type ContextModule } from "@app/server-kit";
import { Elysia } from "elysia";
import {
  type CatalogDeps,
  productFacts,
  type SearchError,
  searchProducts,
} from "../application/catalog.ts";
import { MAX_QUANTITY } from "../domain/quantity.ts";
import { catalogAdapters } from "./adapters.ts";

const envelope = <C extends ErrorCode>(code: C, message: string) => ({ error: { code, message } });

const MESSAGES: Record<SearchError, string> = {
  EMPTY_TERMS: "terms: give at least one non-empty search term.",
  INVALID_QUANTITY: `quantity.value: must be above 0 and at most ${MAX_QUANTITY}.`,
  UNSUPPORTED_SOFT_ATTRIBUTE:
    "soft.attribute: supported attributes are countryOfOrigin and category.",
  UPSTREAM_FAILED: "The current mandate could not be read.",
  CATALOG_UNAVAILABLE: "The product index could not be loaded.",
};

export const createApi = (deps: CatalogDeps = catalogAdapters()) =>
  new Elysia({ prefix: "/catalog" })
    .use(badRequestEnvelope())
    .post(
      "/search",
      {
        body: SearchRequestSchema,
        response: { 200: SearchResultSchema, 400: ErrorEnvelopeSchema, 502: ErrorEnvelopeSchema },
      },
      async ({ body, status }) => {
        const result = await searchProducts(deps, body);
        if (result.ok) return result.value;
        const message = MESSAGES[result.error];
        return result.error === "EMPTY_TERMS" ||
          result.error === "INVALID_QUANTITY" ||
          result.error === "UNSUPPORTED_SOFT_ATTRIBUTE"
          ? status(400, envelope("BAD_REQUEST", message))
          : status(502, envelope("UPSTREAM_FAILED", message));
      },
    )
    .post(
      "/facts",
      {
        body: FactsRequestSchema,
        response: { 200: FactsResultSchema, 400: ErrorEnvelopeSchema, 502: ErrorEnvelopeSchema },
      },
      async ({ body, status }) => {
        const result = await productFacts(deps.catalog, body);
        return result.ok
          ? result.value
          : status(502, envelope("UPSTREAM_FAILED", MESSAGES[result.error]));
      },
    );

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "catalog", api: () => createApi() };
