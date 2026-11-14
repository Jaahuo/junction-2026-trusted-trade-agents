import { ErrorEnvelopeSchema, OpenApiDocumentSchema } from "@app/contract";
import { badRequestEnvelope, type ContextModule, notImplemented } from "@app/server-kit";
import { Elysia } from "elysia";
import { skillRoutes } from "./skill.ts";

// Typed stub of SPEC-003; the discovery issue replaces it and adds GET /.well-known/trusted-trade.json as a root route.
export const createApi = () =>
  new Elysia({ prefix: "/discovery" })
    .use(badRequestEnvelope())
    .get(
      "/openapi.json",
      { response: { 200: OpenApiDocumentSchema, 501: ErrorEnvelopeSchema } },
      ({ status }) => status(501, notImplemented("openapi")),
    );

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "discovery", api: createApi, root: skillRoutes };
