import { type ContextModule, env } from "@app/server-kit";
import { Elysia } from "elysia";
import { edenTradeRest } from "../infra/eden-rest.ts";
import { fsSkillPack } from "../infra/skill-files.ts";
import { httpViewPages } from "../infra/view-pages.ts";
import { handleMcpRequest, type McpDeps, viewToolsMode } from "./mcp-server.ts";

// The MCP binding (SPEC-012) has no /api routes; it serves `ALL /mcp` through `root`.
export const createApi = () => new Elysia({ prefix: "/mcp" });

export type Api = ReturnType<typeof createApi>;

type RootDeps = Omit<McpDeps, "skills"> & Partial<Pick<McpDeps, "skills">>;

export const createRoot = (
  deps: RootDeps = {
    rest: edenTradeRest(),
    views: httpViewPages(),
    viewTools: viewToolsMode(env("MCP_VIEW_TOOLS")),
  },
) =>
  new Elysia().all("/mcp", { parse: "none" }, ({ request }) =>
    handleMcpRequest(request, { skills: fsSkillPack(), ...deps }),
  );

export const context: ContextModule = { name: "mcp", api: createApi, root: () => createRoot() };
