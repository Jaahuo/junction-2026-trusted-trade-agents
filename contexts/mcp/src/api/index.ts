import type { ContextModule } from "@app/server-kit";
import { Elysia } from "elysia";

// The MCP binding (SPEC-012) has no /api routes. The mcp issue adds `ALL /mcp` through `root`.
export const createApi = () => new Elysia({ prefix: "/mcp" });

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "mcp", api: createApi };
