import {
  DecideApprovalInputSchema,
  ErrorEnvelopeSchema,
  type Order,
  OrderSchema,
  PendingListSchema,
  RegisterMandateRequestSchema,
  ROUTES,
  TOOL_OUTPUT,
  type ToolName,
  VIEWS,
} from "@app/contract";
import { pick } from "./locale.ts";
import { HARNESS_MANDATE, harnessDecide } from "./harness-decide.ts";

/** The orders in a loaded tool result: a pending list or one order. */
const ordersIn = (raw: unknown): Order[] => {
  const list = PendingListSchema.safeParse(raw);
  if (list.success) return list.data.orders;
  const one = OrderSchema.safeParse(raw);
  return one.success ? [one.data] : [];
};

// The view loader (SPEC-013), free of the DOM so tests can inject a fake host or fetch.
// A source delivers the tool result and calls action tools; the loader parses every
// result with TOOL_OUTPUT and turns it into a view state.

export type ViewName = (typeof VIEWS)[number]["view"];
export type ViewEntry = (typeof VIEWS)[number];
export type ViewEntryOf<V extends ViewName> = Extract<ViewEntry, { view: V }>;
type Outputs = { [T in ToolName]: ReturnType<(typeof TOOL_OUTPUT)[T]["parse"]> };
export type ToolOutput<T extends ToolName> = Outputs[T];
/** The parsed tool result of a view: the output of one of its tools. */
export type EntryData<E extends ViewEntry> = ToolOutput<E["tools"][number]>;
export type ViewData<V extends ViewName> = EntryData<ViewEntryOf<V>>;

export type ViewState<T> =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string; plainUrl: string | null }
  | { kind: "done"; data: T };

/** Where a view gets its tool result (`structuredContent`) and calls its action tools. */
export type Source = {
  load: () => Promise<unknown>;
  call: (tool: ToolName, args: Record<string, unknown>) => Promise<unknown>;
  /** Sends a message to the agent in the chat; absent outside a chat (plain mode). */
  message?: (text: string) => Promise<void>;
  /** Tells the model something without a chat message (MCP Apps updateModelContext). */
  context?: (text: string) => Promise<void>;
  /** The tool's arguments, which a host sends before the result (MCP Apps ontoolinput). */
  input?: Promise<Record<string, unknown>>;
};

/** The part of the MCP Apps bridge (`App` of ext-apps) a view uses. */
export type Host = {
  onToolResult: (listener: (structuredContent: unknown) => void) => void;
  callServerTool: (request: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<{ isError?: boolean; structuredContent?: unknown; text?: string }>;
  /** Posts a user message to the chat; false when the host rejects it. */
  sendMessage: (text: string) => Promise<boolean>;
  /** Updates what the model knows about the view, without a chat message. */
  updateModelContext: (text: string) => Promise<void>;
  /** Receives the tool's arguments, before the result. */
  onToolInput?: (listener: (args: Record<string, unknown>) => void) => void;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The data of a tool result: its `structuredContent`, else the JSON text item the server adds
 * after the summary, for a host that passes the view only the text content.
 */
export function resultData(result: {
  structuredContent?: unknown;
  content?: readonly { type: string; text?: string }[];
}): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  for (const item of (result.content ?? []).toReversed()) {
    const data = item.type === "text" && item.text !== undefined ? parseJson(item.text) : undefined;
    if (typeof data === "object" && data !== null) return data;
  }
  return undefined;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The VIEWS entry of a view. */
export function viewEntry<V extends ViewName>(view: V) {
  const entry = VIEWS.find((e): e is ViewEntryOf<V> => e.view === view);
  if (entry === undefined) throw new Error(`${view} is not in VIEWS.`);
  return entry;
}

/** Host mode: the tool result arrives through the bridge, actions are server-tool calls. */
export function hostSource(host: Host): Source {
  const result = new Promise<unknown>((resolve) => host.onToolResult(resolve));
  const onToolInput = host.onToolInput;
  // Open WebUI confirms each request and cancels one sent while a confirmation is open.
  let queue = Promise.resolve();
  const oneAtATime = <T>(run: () => Promise<T>) => {
    const next = queue.then(run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    ...(onToolInput === undefined
      ? {}
      : { input: new Promise<Record<string, unknown>>((resolve) => onToolInput(resolve)) }),
    load: () => result,
    call: (name, args) =>
      oneAtATime(async () => {
        const response = await host.callServerTool({ name, arguments: args });
        // The server's reason ("OFFER_EXPIRED: …") is the error's text content.
        if (response.isError === true) throw new Error(response.text ?? `${name} failed.`);
        return response.structuredContent;
      }),
    message: (text) =>
      oneAtATime(async () => {
        if (!(await host.sendMessage(text))) throw new Error("The chat did not take the message.");
      }),
    context: (text) => host.updateModelContext(text),
  };
}

type Route = (typeof ROUTES)[number];

async function request(fetch: Fetch, baseUrl: string, route: Route, args: Record<string, unknown>) {
  const params = new Set<string>();
  const path = route.path.replaceAll(/:(\w+)/g, (_, name: string) => {
    const value = args[name];
    if (typeof value !== "string") throw new Error(`${route.key} needs ${name}.`);
    params.add(name);
    return encodeURIComponent(value);
  });
  const body = Object.fromEntries(Object.entries(args).filter(([key]) => !params.has(key)));
  const response = await fetch(
    `${baseUrl}${path}`,
    route.method === "GET"
      ? { method: "GET" }
      : {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    const envelope = ErrorEnvelopeSchema.safeParse(await response.json().catch(() => null));
    throw new Error(
      envelope.success
        ? `${envelope.data.error.code}: ${envelope.data.error.message}`
        : `${route.method} ${path} answered ${response.status}.`,
    );
  }
  return response.json();
}

/**
 * Plain mode (`/views/<view>?<plainQuery>=<id>`): loads `plainLoad` over REST and calls
 * each action through its ROUTES entry. No token in the first build.
 */
export function plainSource(
  view: ViewName,
  options: { fetch: Fetch; baseUrl: string; query: URLSearchParams },
): Source {
  const entry = viewEntry(view);
  const routeOf = (match: (route: Route) => boolean, name: string) => {
    const route = ROUTES.find(match);
    if (route === undefined) throw new Error(`${view} has no plain route for ${name}.`);
    return route;
  };
  return {
    load: async () => {
      const id = entry.plainQuery === null ? null : options.query.get(entry.plainQuery);
      // Without the query, a view with a list route loads the list (the open orders).
      const key = id === null && entry.plainList !== null ? entry.plainList : entry.plainLoad;
      const route = routeOf((r) => r.key === key, "loading");
      const param = /:(\w+)/.exec(route.path)?.[1];
      const args = param === undefined || id === null ? {} : { [param]: id };
      return request(options.fetch, options.baseUrl, route, args);
    },
    call: async (tool, args) =>
      request(
        options.fetch,
        options.baseUrl,
        routeOf((r) => r.tool === tool, tool),
        args,
      ),
  };
}

/** Harness mode: the API injects `{ state: "loading" }` or `{ result }` into the built view. */
export function fixtureSource(fixture: unknown, now = () => new Date().toISOString()): Source {
  const result =
    typeof fixture === "object" && fixture !== null && "result" in fixture
      ? Promise.resolve(fixture.result)
      : new Promise<never>(() => {});
  // The orders as decided so far, so a second decision builds on the first.
  const orders = new Map<string, Order>();
  // The mandate as registered so far, so a rule saved on the card shows in the next read.
  let mandate = HARNESS_MANDATE;
  return {
    load: () => result,
    call: async (tool, args) => {
      if (tool === "get_mandate") return mandate;
      if (tool === "get_order_status") {
        const orderId = args["orderId"];
        const order =
          typeof orderId === "string"
            ? (orders.get(orderId) ?? ordersIn(await result).find((o) => o.orderId === orderId))
            : undefined;
        if (order === undefined)
          throw new Error(`NOT_FOUND: The harness has no order ${String(orderId)}.`);
        return order;
      }
      if (tool === "register_mandate") {
        const { limits, standingConstraints, exp } = RegisterMandateRequestSchema.parse(args);
        mandate = {
          ...mandate,
          mandate: {
            ...mandate.mandate,
            version: mandate.mandate.version + 1,
            limits,
            standingConstraints,
            exp: exp ?? mandate.mandate.exp,
          },
        };
        return mandate;
      }
      const input = DecideApprovalInputSchema.safeParse(args);
      if (tool !== "decide_approval" || !input.success)
        throw new Error(`The harness has no server to call ${tool}.`);
      const order =
        orders.get(input.data.orderId) ??
        ordersIn(await result).find((o) => o.orderId === input.data.orderId);
      if (order === undefined) throw new Error(`The harness has no order ${input.data.orderId}.`);
      const updated = harnessDecide(order, input.data, now());
      orders.set(updated.orderId, updated);
      return updated;
    },
    // The harness shows the chat states, so messages are accepted and dropped.
    message: async () => {},
    context: async () => {},
  };
}

/** The plain page of a view, or null when it has none (the approval card links to `approvalUrl`). */
export function plainPageUrl(view: ViewName, baseUrl: string, id: string | null = null) {
  const entry = viewEntry(view);
  if (entry.plainLoad == null) return null;
  const query = entry.plainQuery === null || id === null ? "" : `?${entry.plainQuery}=${id}`;
  return `${baseUrl}/views/${view}${query}`;
}

const LISTS = new Set(["candidates", "offers", "orders"]);
/** A result whose list (search candidates, offers, pending orders) is empty shows the empty state. */
const isEmpty = (data: object) =>
  Object.entries(data).some(
    ([key, value]) => LISTS.has(key) && Array.isArray(value) && value.length === 0,
  );

const error = (message: string, plainUrl: string | null = null) =>
  ({ kind: "error", message, plainUrl }) as const;

type Parser<T> = {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
};
const OUTPUT: { [T in ToolName]: Parser<Outputs[T]> } = TOOL_OUTPUT;

function parseWith<T extends ToolName>(tool: T, value: unknown): Outputs[T] | null {
  const parsed = OUTPUT[tool].safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parse<T extends ToolName>(tools: readonly T[], value: unknown): Outputs[T] | null {
  for (const tool of tools) {
    const data = parseWith(tool, value);
    if (data !== null) return data;
  }
  return null;
}

/** Parses a tool result with the TOOL_OUTPUT schema of the view's tools. */
export function parseResult<E extends ViewEntry>(
  entry: E,
  value: unknown,
): ViewState<EntryData<E>> {
  const data = parse<E["tools"][number]>(entry.tools, value);
  if (data === null)
    return error(
      pick({
        en: "The tool result does not match the contract.",
        fi: "Työkalun tulos ei ole sovitussa muodossa.",
      }),
    );
  return isEmpty(data) ? { kind: "empty" } : { kind: "done", data };
}

export async function loadView<E extends ViewEntry>(
  entry: E,
  source: Source,
): Promise<ViewState<EntryData<E>>> {
  try {
    return parseResult(entry, await source.load());
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "The view could not load.");
  }
}

/** Calls an action tool; a failure gives the error state with the link to the plain page. */
export async function callAction<T extends ToolName>(
  source: Source,
  tool: T,
  args: Record<string, unknown>,
  plainUrl: string | null,
): Promise<ViewState<ToolOutput<T>>> {
  try {
    const data = parseWith(tool, await source.call(tool, args));
    return data === null
      ? error(`${tool} answered outside the contract.`, plainUrl)
      : { kind: "done", data };
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : `${tool} failed.`, plainUrl);
  }
}
