import { OpenApiDocumentSchema } from "@app/contract";
import { badRequestEnvelope, type ContextModule, publicBaseUrl } from "@app/server-kit";
import { Elysia } from "elysia";
import { openApiDocument } from "./openapi.ts";
import { skillRoutes } from "./skill.ts";
import { discoveryDocument } from "./well-known.ts";

/** `baseUrl` is read on every request, so a new PUBLIC_BASE_URL changes every URL. */
export const discoveryApi = (baseUrl: () => string) =>
  new Elysia({ prefix: "/discovery" })
    .use(badRequestEnvelope())
    .get("/openapi.json", { response: { 200: OpenApiDocumentSchema } }, () =>
      openApiDocument(baseUrl()),
    );

export const createApi = () => discoveryApi(publicBaseUrl);

export type Api = ReturnType<typeof createApi>;

/** Root routes: the SPEC-014 discovery document and the skill files. */
export const discoveryRoot = (baseUrl: () => string) =>
  new Elysia()
    .use(skillRoutes())
    .get("/.well-known/trusted-trade.json", () => discoveryDocument(baseUrl()));

export const rootRoutes = () => discoveryRoot(publicBaseUrl);

export const context: ContextModule = { name: "discovery", api: createApi, root: rootRoutes };
