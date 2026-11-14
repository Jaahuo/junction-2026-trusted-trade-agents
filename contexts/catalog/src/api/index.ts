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
import { type CatalogDeps, productFacts, searchProducts } from "../application/catalog.ts";
import { catalogAdapters } from "./adapters.ts";

const envelope = <C extends ErrorCode>(code: C, message: string) => ({ error: { code, message } });

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
        return result.error === "EMPTY_TERMS"
          ? status(400, envelope("BAD_REQUEST", "terms: give at least one non-empty search term."))
          : status(502, envelope("UPSTREAM_FAILED", "The current mandate could not be read."));
      },
    )
    .post(
      "/facts",
      { body: FactsRequestSchema, response: { 200: FactsResultSchema, 400: ErrorEnvelopeSchema } },
      async ({ body }) => productFacts(deps.catalog, body),
    );

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "catalog", api: () => createApi() };
