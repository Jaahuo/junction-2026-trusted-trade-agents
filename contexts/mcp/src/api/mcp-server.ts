import {
  MODEL_TOOLS,
  TOOL_INPUT,
  TOOL_OUTPUT,
  type ToolName,
  VIEW_TOOLS,
  VIEWS,
} from "@app/contract";
import type { McpUiToolMeta } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ServerCapabilities,
  type Tool,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SKILL_NAME, skillUri } from "../domain/skill.ts";
import { loadSkill, type SkillPack } from "../application/skills.ts";
import { runTool, type ToolReply, type TradeRest, type ViewPages } from "../application/tools.ts";

export type ViewToolsMode = "app" | "off";

/** Reads `MCP_VIEW_TOOLS`: `app` (default) or `off` (SPEC-012). */
export const viewToolsMode = (value: string | undefined): ViewToolsMode => {
  if (value === undefined || value === "app" || value === "off") return value ?? "app";
  throw new Error(`MCP_VIEW_TOOLS must be "app" or "off", not "${value}".`);
};

export interface McpDeps {
  readonly rest: TradeRest;
  readonly views: ViewPages;
  readonly viewTools: ViewToolsMode;
  readonly skills: SkillPack;
}

// MCP's resource-not-found code; the SDK's ErrorCode enum does not list it.
const RESOURCE_NOT_FOUND = -32002;

const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const SERVER_INFO = { name: "trusted-trade", version: "0.1.0" };
// The skill files are static, so a host may cache the answers.
const CACHE = { ttlMs: 300_000, cacheScope: "public" } as const;

// What initialize reports; McpServer adds the same resources capability when it registers a resource.
const CAPABILITIES: ServerCapabilities = {
  tools: {},
  resources: { listChanged: true },
  extensions: { [SKILLS_EXTENSION]: {} },
};

const DiscoverRequestSchema = z.object({
  method: z.literal("server/discover"),
  params: z.looseObject({}).optional(),
});
const ListSkillsRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.looseObject({ cursor: z.string().optional() }).optional(),
});
const GetSkillRequestSchema = z.object({
  method: z.literal("skills/get"),
  // Checked in the handler: a schema failure would answer -32603, not -32602.
  params: z.looseObject({ uri: z.unknown().optional() }).optional(),
});

const DESCRIPTIONS: Record<ToolName, string> = {
  search_products:
    "Find candidate products for a structured need: search terms, hard constraints (allergens and free-from claims as free_from, vegan as yes) and soft constraints, a quantity with unit and a deliver-by date. Returns each candidate with a per-constraint match and the quantity in sales units. Uses static data only.",
  get_offers:
    "Get one signed offer per shortlisted product, with price, delivery date, stock and a pre-check result. Pass the offer tokens to place_order.",
  place_order:
    "Place an order from signed offer tokens with an idempotency key. The order is placed, pending human approval or rejected, with reason codes. A pending order has an approvalUrl for the human; do not approve it yourself.",
  get_order_status: "Get the current status and the audit record of an order.",
  get_mandate: "Get the purchasing limits currently in force for this agent.",
  list_pending_approvals: "List the orders that wait for a human approval decision.",
  decide_approval:
    "Record a human approval decision on a pending order. Only the approval view calls this tool.",
  register_mandate:
    "Register a new mandate and revoke the previous one. Only the mandate view calls this tool.",
  revoke_mandate: "Revoke a mandate. Only the mandate view calls this tool.",
};

/**
 * Views a host does not show in the chat yet. The offer comparison is a placeholder until #22,
 * and the agent calls get_offers several times per order, so each call would add an empty card.
 */
export const VIEWS_NOT_IN_CHAT: ReadonlySet<string> = new Set(["offer-comparison"]);

/** The view a tool shows in the chat, if any. */
const chatViewOf = (name: ToolName) => {
  const view = VIEWS.find((entry) => entry.tools.some((tool) => tool === name));
  return view === undefined || VIEWS_NOT_IN_CHAT.has(view.view) ? undefined : view;
};

const toolMeta = (name: ToolName): Record<string, unknown> => {
  if (VIEW_TOOLS.some((tool) => tool === name)) {
    const ui: McpUiToolMeta = { visibility: ["app"] };
    return { ui };
  }
  const view = chatViewOf(name);
  if (view === undefined) return {};
  const ui: McpUiToolMeta = { resourceUri: view.uri };
  // The flat key mirrors ext-apps' registerAppTool, for hosts that read the older form.
  return { ui, [RESOURCE_URI_META_KEY]: view.uri };
};

// An error has no structuredContent: SDK clients check it against outputSchema even when isError is set.
const toCallToolResult = (reply: ToolReply<ToolName>): CallToolResult => {
  const content = [
    { type: "text" as const, text: reply.text },
    { type: "text" as const, text: JSON.stringify(reply.data) },
  ];
  return reply.isError ? { content, isError: true } : { content, structuredContent: reply.data };
};

// A tool with a view also takes the conversation's language, which only the view reads
// (SPEC-012). It is not part of the REST input, so the server drops it before the call.
const LANGUAGE = {
  type: "string",
  description:
    "The language the user writes in, as a BCP 47 tag such as fi or en. The view shows its text in it.",
};

const inputSchema = (name: ToolName) => {
  const schema = z.toJSONSchema(TOOL_INPUT[name], { target: "draft-7", io: "input" });
  if (chatViewOf(name) === undefined) return schema;
  return { ...schema, properties: { ...schema["properties"], language: LANGUAGE } };
};

const withoutLanguage = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).filter(([key]) => key !== "language"));

// The same JSON Schema options as McpServer.registerTool uses; ToolSchema checks they are object schemas.
const toolDefinition = (name: ToolName): Tool =>
  ToolSchema.parse({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: inputSchema(name),
    outputSchema: z.toJSONSchema(TOOL_OUTPUT[name], { target: "draft-7", io: "output" }),
    _meta: toolMeta(name),
  });

/** One MCP server with the SPEC-003 tools and the SPEC-013 view resources. */
const createMcpServer = ({ rest, views, viewTools, skills }: McpDeps): McpServer => {
  const server = new McpServer(SERVER_INFO);
  server.server.registerCapabilities(CAPABILITIES);
  const tools: readonly ToolName[] =
    viewTools === "app" ? [...MODEL_TOOLS, ...VIEW_TOOLS] : MODEL_TOOLS;
  // Tools use the low-level handlers: registerTool answers invalid input with its own text, without BAD_REQUEST.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(toolDefinition),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const name = tools.find((tool) => tool === params.name);
    if (name === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${params.name} not found.`);
    }
    return toCallToolResult(await runTool(rest, name, withoutLanguage(params.arguments ?? {})));
  });
  for (const { view, uri } of VIEWS) {
    server.registerResource(view, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
      const html = await views.html(view);
      if (!html.ok) {
        const code = html.error === "NOT_FOUND" ? RESOURCE_NOT_FOUND : ErrorCode.InternalError;
        throw new McpError(code, `The view ${view} is not available: ${html.error}.`);
      }
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html.value }] };
    });
  }
  registerSkills(server, skills);
  return server;
};

/** The Skills extension. The SDK speaks only the initialize era, so `server/discover` answers with the legacy versions. */
const registerSkills = (server: McpServer, skills: SkillPack): void => {
  const loaded = async () => {
    const skill = await loadSkill(skills);
    if (!skill.ok) {
      throw new McpError(ErrorCode.InternalError, `The skill is not available: ${skill.error}.`);
    }
    return skill.value;
  };
  server.server.setRequestHandler(DiscoverRequestSchema, () => ({
    resultType: "complete",
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: CAPABILITIES,
    ...CACHE,
    _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
  }));
  server.server.setRequestHandler(ListSkillsRequestSchema, async () => ({
    resultType: "complete",
    skills: [(await loaded()).entry],
    ...CACHE,
  }));
  server.server.setRequestHandler(GetSkillRequestSchema, async ({ params }) => {
    const { entry } = await loaded();
    if (params?.uri !== entry.uri) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${String(params?.uri)}.`);
    }
    return { resultType: "complete", skill: entry, ...CACHE };
  });
  // A template, so the files stay out of resources/list, which lists the views.
  server.registerResource(
    SKILL_NAME,
    new ResourceTemplate(skillUri("{file}"), { list: undefined }),
    { mimeType: "text/markdown" },
    async (uri, { file }) => {
      const name = Array.isArray(file) ? file[0] : file;
      const found = (await loaded()).files.find((entry) => entry.name === name);
      if (name === undefined || found === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown skill file: ${uri.href}.`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: new TextDecoder().decode(found.bytes),
          },
        ],
      };
    },
  );
};

/** Stateless streamable HTTP: a new server and transport per request, with JSON responses. */
export const handleMcpRequest = async (request: Request, deps: McpDeps): Promise<Response> => {
  if (request.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  const server = createMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
};
