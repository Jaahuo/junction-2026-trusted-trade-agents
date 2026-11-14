import {
  ErrorEnvelopeSchema,
  FactsRequestSchema,
  FactsResultSchema,
  SearchRequestSchema,
  SearchResultSchema,
} from "@app/contract";
import { badRequestEnvelope, type ContextModule, notImplemented } from "@app/server-kit";
import { Elysia } from "elysia";

// Typed stubs of SPEC-003; the catalog issue replaces them.
export const createApi = () =>
  new Elysia({ prefix: "/catalog" })
    .use(badRequestEnvelope())
    .post(
      "/search",
      {
        body: SearchRequestSchema,
        response: { 200: SearchResultSchema, 501: ErrorEnvelopeSchema },
      },
      ({ status }) => status(501, notImplemented("search")),
    )
    .post(
      "/facts",
      { body: FactsRequestSchema, response: { 200: FactsResultSchema, 501: ErrorEnvelopeSchema } },
      ({ status }) => status(501, notImplemented("facts")),
    );

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "catalog", api: createApi };
