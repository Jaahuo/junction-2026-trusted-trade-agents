import { describe, expect, test } from "bun:test";
import {
  type ErrorEnvelope,
  fixtures,
  MODEL_TOOLS,
  type Order,
  TOOL_INPUT,
  TOOL_OUTPUT,
  type ToolName,
  VIEW_TOOLS,
  VIEWS,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { TradeRest, ViewName, ViewPages } from "../application/tools.ts";
import { createRoot } from "./index.ts";
import { type McpDeps, viewToolsMode } from "./mcp-server.ts";

const placed: Order = { ...fixtures.order, status: "placed", approvalUrl: null };

interface Call {
  readonly route: keyof TradeRest;
  readonly args: readonly unknown[];
}

const fakeRest = (failure?: ErrorEnvelope) => {
  const calls: Call[] = [];
  const reply =
    <T>(route: keyof TradeRest, value: T) =>
    async (...args: unknown[]): Promise<Result<T, ErrorEnvelope>> => {
      calls.push({ route, args });
      return failure === undefined ? ok(value) : err(failure);
    };
  const rest: TradeRest = {
    search: reply("search", fixtures.searchResult),
    offers: reply("offers", fixtures.offersResult),
    place: reply("place", fixtures.order),
    status: reply("status", placed),
    mandate: reply("mandate", fixtures.storedMandate),
    pending: reply("pending", fixtures.pendingList),
    decide: reply("decide", placed),
    register: reply("register", fixtures.storedMandate),
    revoke: reply("revoke", { ...fixtures.storedMandate, status: "revoked" as const }),
  };
  return { rest, calls };
};

const fakeViews: ViewPages = {
  html: async (view: ViewName) =>
    view === "approval-card" ? ok(`<html>${view}</html>`) : err("NOT_FOUND"),
};

const inputs: { [T in ToolName]: z.input<(typeof TOOL_INPUT)[T]> } = {
  search_products: fixtures.searchRequest,
  get_offers: fixtures.offersRequest,
  place_order: fixtures.placeOrderRequest,
  get_order_status: { orderId: fixtures.order.orderId },
  get_mandate: {},
  list_pending_approvals: {},
  decide_approval: fixtures.decideApprovalInput,
  register_mandate: fixtures.registerMandateRequest,
  revoke_mandate: { mandateId: fixtures.storedMandate.mandate.mandateId },
};

const ToolSchema = z.looseObject({
  name: z.string(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  _meta: z
    .looseObject({
      ui: z
        .looseObject({
          resourceUri: z.string().optional(),
          visibility: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});
const uiOf = ({ _meta: meta }: z.infer<typeof ToolSchema>) => meta?.ui;
const ToolsListSchema = z.looseObject({ result: z.looseObject({ tools: z.array(ToolSchema) }) });
const CallResultSchema = z.looseObject({
  result: z.looseObject({
    content: z.array(z.looseObject({ type: z.literal("text"), text: z.string() })).min(1),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
});

const mcp = (overrides: Partial<McpDeps> = {}) => {
  const { rest, calls } = fakeRest();
  const app = createRoot({ rest, views: fakeViews, viewTools: "app", ...overrides });
  const rpc = async (method: string, params: object = {}): Promise<unknown> => {
    const response = await app.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    return response.json();
  };
  const listTools = async () => ToolsListSchema.parse(await rpc("tools/list")).result.tools;
  const callTool = async (name: string, args: object) =>
    CallResultSchema.parse(await rpc("tools/call", { name, arguments: args })).result;
  return { app, rpc, calls, listTools, callTool };
};

describe("tools/list", () => {
  test("MCP_VIEW_TOOLS=app lists the six model tools and the three view tools as app-only", async () => {
    const tools = await mcp().listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      [...MODEL_TOOLS, ...VIEW_TOOLS].toSorted(),
    );
    for (const tool of tools) {
      const appOnly = VIEW_TOOLS.some((name) => name === tool.name);
      expect({ name: tool.name, visibility: uiOf(tool)?.visibility }).toEqual({
        name: tool.name,
        visibility: appOnly ? ["app"] : undefined,
      });
    }
  });

  test("MCP_VIEW_TOOLS=off does not register the view tools", async () => {
    const tools = await mcp({ viewTools: "off" }).listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([...MODEL_TOOLS].toSorted());
  });

  test("MCP_VIEW_TOOLS defaults to app, accepts off and rejects other values", () => {
    expect(viewToolsMode(undefined)).toBe("app");
    expect(viewToolsMode("app")).toBe("app");
    expect(viewToolsMode("off")).toBe("off");
    expect(() => viewToolsMode("hidden")).toThrow("MCP_VIEW_TOOLS");
  });

  test("every tool's inputSchema is TOOL_INPUT[tool] and its outputSchema is TOOL_OUTPUT[tool]", async () => {
    for (const tool of await mcp().listTools()) {
      const name = z.enum([...MODEL_TOOLS, ...VIEW_TOOLS]).parse(tool.name);
      expect({ name, input: tool.inputSchema, output: tool.outputSchema }).toEqual({
        name,
        input: z.toJSONSchema(TOOL_INPUT[name], { target: "draft-7", io: "input" }),
        output: z.toJSONSchema(TOOL_OUTPUT[name], { target: "draft-7", io: "output" }),
      });
    }
  });

  test("each tool in VIEWS declares the view's ui:// resource", async () => {
    const tools = await mcp().listTools();
    for (const view of VIEWS) {
      for (const name of view.tools) {
        const tool = tools.find((entry) => entry.name === name);
        expect({ name, uri: tool === undefined ? undefined : uiOf(tool)?.resourceUri }).toEqual({
          name,
          uri: view.uri,
        });
      }
    }
  });
});

describe("tools/call", () => {
  test("every tool returns text content and structuredContent that parses with TOOL_OUTPUT", async () => {
    const { callTool } = mcp();
    for (const name of [...MODEL_TOOLS, ...VIEW_TOOLS]) {
      const result = await callTool(name, inputs[name]);
      expect({ name, isError: result.isError }).toEqual({ name, isError: undefined });
      expect(result.content[0]?.text).not.toBe("");
      expect(TOOL_OUTPUT[name].safeParse(result.structuredContent).success).toBe(true);
    }
  });

  test("search_products structuredContent equals the REST body", async () => {
    const { callTool, calls } = mcp();
    const result = await callTool("search_products", fixtures.searchRequest);
    expect(result.structuredContent).toEqual(fixtures.searchResult);
    expect(calls).toEqual([{ route: "search", args: [fixtures.searchRequest] }]);
  });

  test("a pending place_order text contains the approvalUrl", async () => {
    const result = await mcp().callTool("place_order", fixtures.placeOrderRequest);
    expect(result.content[0]?.text).toContain(`${fixtures.order.approvalUrl}`);
  });

  test("get_order_status passes orderId as the path parameter", async () => {
    const { callTool, calls } = mcp();
    await callTool("get_order_status", { orderId: "ord_42" });
    expect(calls).toEqual([{ route: "status", args: ["ord_42"] }]);
  });

  test("decide_approval passes orderId as the path parameter and the decision fields as the body", async () => {
    const { callTool, calls } = mcp();
    await callTool("decide_approval", fixtures.decideApprovalInput);
    expect(calls).toEqual([
      {
        route: "decide",
        args: [fixtures.decideApprovalInput.orderId, fixtures.decideApprovalRequest],
      },
    ]);
  });

  test("decide_approval with a field that does not belong to the decision gives isError BAD_REQUEST", async () => {
    const { callTool, calls } = mcp();
    const result = await callTool("decide_approval", {
      orderId: "ord_42",
      proposalVersion: 1,
      decision: "approve",
      next: "stop",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/^BAD_REQUEST: .*next/);
    expect(calls).toEqual([]);
  });

  test("decide_approval with an unknown key gives isError BAD_REQUEST without a REST call", async () => {
    const { callTool, calls } = mcp();
    const result = await callTool("decide_approval", {
      orderId: "ord_42",
      proposalVersion: 1,
      decision: "approve",
      foo: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/^BAD_REQUEST: .*foo/);
    expect(calls).toEqual([]);
  });

  test("an input with a customer field gives isError BAD_REQUEST without a REST call", async () => {
    const { callTool, calls } = mcp();
    const result = await callTool("get_mandate", { customer: "someone" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^BAD_REQUEST: .*customer/);
    expect(calls).toEqual([]);
  });

  test("an unknown tool gives a JSON-RPC error", async () => {
    const body = await mcp({ viewTools: "off" }).rpc("tools/call", {
      name: "decide_approval",
      arguments: fixtures.decideApprovalInput,
    });
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: expect.stringContaining("decide_approval") },
    });
  });

  test("a REST error gives isError, the code and the envelope in the text and no structuredContent", async () => {
    const { rest } = fakeRest(fixtures.errorEnvelope);
    const { callTool } = mcp({ rest });
    const result = await callTool("place_order", fixtures.placeOrderRequest);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content.map((block) => block.text)).toEqual([
      "STALE_OFFER: Request new offers. Next delivery date: 2026-11-20.",
      JSON.stringify(fixtures.errorEnvelope),
    ]);
  });
});

describe("resources", () => {
  test("resources/list has one text/html;profile=mcp-app resource per view", async () => {
    const body = z
      .looseObject({
        result: z.looseObject({
          resources: z.array(z.looseObject({ uri: z.string(), mimeType: z.string() })),
        }),
      })
      .parse(await mcp().rpc("resources/list"));
    expect(body.result.resources.map(({ uri, mimeType }) => ({ uri, mimeType }))).toEqual(
      VIEWS.map(({ uri }) => ({ uri, mimeType: "text/html;profile=mcp-app" })),
    );
  });

  test("resources/read of a ui:// URI returns the HTML of GET /views/<view>", async () => {
    expect(await mcp().rpc("resources/read", { uri: "ui://trusted-trade/approval-card" })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        contents: [
          {
            uri: "ui://trusted-trade/approval-card",
            mimeType: "text/html;profile=mcp-app",
            text: "<html>approval-card</html>",
          },
        ],
      },
    });
  });

  test("resources/read of a missing view gives a JSON-RPC error", async () => {
    expect(await mcp().rpc("resources/read", { uri: "ui://trusted-trade/order-timeline" })).toEqual(
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32002, message: expect.stringContaining("order-timeline") },
      },
    );
  });
});

test("GET /mcp answers 405 because the server is stateless", async () => {
  const response = await mcp().app.handle(new Request("http://localhost/mcp"));
  expect(response.status).toBe(405);
});

const connectClient = async (deps: McpDeps) => {
  const app = createRoot(deps);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => app.handle(new Request(input, init)),
    }),
  );
  // listTools loads the output schemas that the client checks results against.
  await client.listTools();
  return client;
};

describe("an MCP SDK client", () => {
  test("gets a REST error as isError with the code, the message and the envelope in the text and no structuredContent", async () => {
    const { rest } = fakeRest(fixtures.errorEnvelope);
    const client = await connectClient({ rest, views: fakeViews, viewTools: "app" });
    const result = await client.callTool({
      name: "place_order",
      arguments: fixtures.placeOrderRequest,
    });
    const text = z
      .array(z.looseObject({ text: z.string() }))
      .parse(result.content)
      .map((block) => block.text)
      .join("\n");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text).toContain("STALE_OFFER");
    expect(text).toContain(fixtures.errorEnvelope.error.message);
    expect(text).toContain(JSON.stringify(fixtures.errorEnvelope));
    await client.close();
  });

  test("gets a successful result with structuredContent", async () => {
    const client = await connectClient({
      rest: fakeRest().rest,
      views: fakeViews,
      viewTools: "app",
    });
    const result = await client.callTool({
      name: "search_products",
      arguments: fixtures.searchRequest,
    });
    expect(result.structuredContent).toEqual(fixtures.searchResult);
    await client.close();
  });
});
