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
import { placeOrderInput } from "../application/place-order-input.ts";
import { SKILL_NAME, skillUri } from "../domain/skill.ts";
import { loadSkill, type SkillPack } from "../application/skills.ts";
import {
  runTool,
  type ToolReply,
  type TradeRest,
  type ViewName,
  type ViewPages,
} from "../application/tools.ts";
import type { ViewUris } from "../application/view-uris.ts";

export type ViewToolsMode = "app" | "off";

/** Reads `MCP_VIEW_TOOLS`: `app` (default) or `off` (SPEC-012). */
export const viewToolsMode = (value: string | undefined): ViewToolsMode => {
  if (value === undefined || value === "app" || value === "off") return value ?? "app";
  throw new Error(`MCP_VIEW_TOOLS must be "app" or "off", not "${value}".`);
};

export interface McpDeps {
  readonly rest: TradeRest;
  readonly views: ViewPages;
  readonly viewUris: ViewUris;
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
    "Show the user candidate products for a structured need: search terms, hard constraints (allergens and free-from claims as free_from, vegan as yes) and soft constraints, a quantity with unit and a deliver-by date. Search filters shortlisted static matches by live availability for the date. If availability is unavailable, it returns unfiltered matches. Candidates do not guarantee an offer or the requested quantity. Returns each candidate with a per-constraint match and the quantity in sales units, and opens the search results view. Use it when the user asks to see or browse products; when the user asks you to order, use find_products.",
  find_products:
    "The same search as search_products, without a view. Use it while preparing an order, once per product the user names, with the same full originalRequest each time. Same input and result as search_products.",
  get_offers:
    "Show the user signed offers for shortlisted candidates, with price, delivery date, stock and a pre-check result, in the offer comparison view. When the earliest available date is on or before deliverBy, the offer selects deliverBy. If the date advances, the cutoff is inferred by shifting it the same calendar days at the same Europe/Helsinki clock time; stock is unconfirmed. The price applies to the actual delivery date. Offer claims are authoritative. Use it when the user asks to compare offers; when the user asks you to order, use quote_offers. Pass each chosen offerId to place_order.",
  quote_offers:
    "The same signed offers as get_offers, without a view. When the earliest available date is on or before deliverBy, the offer selects deliverBy. If the date advances, the cutoff is inferred by shifting it the same calendar days at the same Europe/Helsinki clock time; stock is unconfirmed. The price applies to the actual delivery date. Offer claims are authoritative. Quote the shortlists for all requested products together. For each product prefer precheck auto, then lower gross price per standard unit when both prices are non-null and units match, then earlier delivery. Pass each chosen offerId to place_order.",
  place_order:
    "Place one order from the offerIds of signed offers (from get_offers or quote_offers), one per requested product, up to 20 chosen offers. Optional alternatives have a separate limit of 20 across the entire order; retain every chosen product. Put every product of a request in the same order: limits apply to the order total. Do not silently place a partial order. The server handles idempotency: retry with the same offers, alternatives and supersedes after a lost reply. Pass the short offerId (off_…), not the long token. The order is placed, pending human approval or rejected, with reason codes. When the user changes an earlier pending proposal, pass supersedes with its orderId and proposalVersion. An accepted replacement closes only that earlier proposal. Do not replace unrelated orders. A pending order has an approvalUrl for the human; do not approve it yourself.",
  get_order_status: "Get the current status and the audit record of an order.",
  get_mandate:
    "Get the purchasing limits currently in force for this agent, without opening a view. Use it to check limits while preparing or placing an order. When the user asks to see the limits, use show_mandate.",
  show_mandate:
    "Show the purchasing limits currently in force in the mandate settings view. Use it only when the user asks to see the agent's limits or settings. While preparing or placing an order, use get_mandate instead. Same input and result as get_mandate.",
  draft_mandate:
    "Draft new purchasing limits (a mandate) from the terms the human gave, to set or change the limits or after MANDATE_INVALID. Nothing is registered: the mandate view shows the draft next to the current limits, and only the human registers it there with the Register button. The limits are not in force until get_mandate shows them.",
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

type AnnouncedUris = ReadonlyMap<ViewName, string>;

const toolMeta = (name: ToolName, uris: AnnouncedUris): Record<string, unknown> => {
  if (VIEW_TOOLS.some((tool) => tool === name)) {
    const ui: McpUiToolMeta = { visibility: ["app"] };
    return { ui };
  }
  const view = chatViewOf(name);
  if (view === undefined) return {};
  const uri = uris.get(view.view) ?? view.uri;
  const ui: McpUiToolMeta = { resourceUri: uri };
  // The flat key mirrors ext-apps' registerAppTool, for hosts that read the older form.
  return { ui, [RESOURCE_URI_META_KEY]: uri };
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
  const schema = z.toJSONSchema(name === "place_order" ? placeOrderInput : TOOL_INPUT[name], {
    target: "draft-7",
    io: "input",
  });
  if (chatViewOf(name) === undefined) return schema;
  return { ...schema, properties: { ...schema["properties"], language: LANGUAGE } };
};

const withoutLanguage = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).filter(([key]) => key !== "language"));

// The same JSON Schema options as McpServer.registerTool uses; ToolSchema checks they are object schemas.
const toolDefinition = (name: ToolName, uris: AnnouncedUris): Tool =>
  ToolSchema.parse({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: inputSchema(name),
    outputSchema: z.toJSONSchema(TOOL_OUTPUT[name], { target: "draft-7", io: "output" }),
    _meta: toolMeta(name, uris),
  });

/** The versioned URI of each view that one of the tools shows in the chat. */
const announcedUris = async (
  tools: readonly ToolName[],
  viewUris: ViewUris,
): Promise<AnnouncedUris> => {
  const shown = new Set(tools.flatMap((name) => chatViewOf(name)?.view ?? []));
  return new Map(
    await Promise.all([...shown].map(async (view) => [view, await viewUris.uri(view)] as const)),
  );
};

/** One MCP server with the SPEC-003 tools and the SPEC-013 view resources. */
const createMcpServer = ({ rest, views, viewUris, viewTools, skills }: McpDeps): McpServer => {
  const server = new McpServer(SERVER_INFO);
  server.server.registerCapabilities(CAPABILITIES);
  const tools: readonly ToolName[] =
    viewTools === "app" ? [...MODEL_TOOLS, ...VIEW_TOOLS] : MODEL_TOOLS;
  // Tools use the low-level handlers: registerTool answers invalid input with its own text, without BAD_REQUEST.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const uris = await announcedUris(tools, viewUris);
    return { tools: tools.map((name) => toolDefinition(name, uris)) };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const name = tools.find((tool) => tool === params.name);
    if (name === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${params.name} not found.`);
    }
    return toCallToolResult(await runTool(rest, name, withoutLanguage(params.arguments ?? {})));
  });
  registerViews(server, views, viewUris);
  registerSkills(server, skills);
  return server;
};

/**
 * Each view under its versioned URI (listed) and its base URI (not listed). A read of any
 * version returns the current HTML under the requested URI, so a host with an older URI still loads.
 */
const registerViews = (server: McpServer, views: ViewPages, viewUris: ViewUris): void => {
  for (const { view, uri: base } of VIEWS) {
    const read = async (uri: URL) => {
      const html = await views.html(view);
      if (!html.ok) {
        const code = html.error === "NOT_FOUND" ? RESOURCE_NOT_FOUND : ErrorCode.InternalError;
        throw new McpError(code, `The view ${view} is not available: ${html.error}.`);
      }
      return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html.value }] };
    };
    const list = async () => ({ resources: [{ uri: await viewUris.uri(view), name: view }] });
    server.registerResource(
      view,
      new ResourceTemplate(`${base}/{version}`, { list }),
      { mimeType: RESOURCE_MIME_TYPE },
      read,
    );
    // A template without variables matches only the base URI and stays out of resources/list.
    server.registerResource(
      `${view}-base`,
      new ResourceTemplate(base, { list: undefined }),
      { mimeType: RESOURCE_MIME_TYPE },
      read,
    );
  }
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
