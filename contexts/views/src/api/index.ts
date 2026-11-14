import type { ContextModule } from "@app/server-kit";
import { Elysia } from "elysia";

// Views (SPEC-013) have no /api routes. The views issue serves `GET /views/:view` from dist/ through `root`.
export const createApi = () => new Elysia({ prefix: "/views" });

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "views", api: createApi };
