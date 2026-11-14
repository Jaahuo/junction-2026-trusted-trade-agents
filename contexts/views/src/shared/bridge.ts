import { ROUTES, TOOL_OUTPUT, type ToolName, VIEWS } from "@app/contract";

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
};

/** The part of the MCP Apps bridge (`App` of ext-apps) a view uses. */
export type Host = {
  onToolResult: (listener: (structuredContent: unknown) => void) => void;
  callServerTool: (request: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<{ isError?: boolean; structuredContent?: unknown }>;
};

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
  return {
    load: () => result,
    call: async (name, args) => {
      const response = await host.callServerTool({ name, arguments: args });
      if (response.isError === true) throw new Error(`${name} failed.`);
      return response.structuredContent;
    },
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
  if (!response.ok) throw new Error(`${route.method} ${path} answered ${response.status}.`);
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
      const route = routeOf((r) => r.key === entry.plainLoad, "loading");
      const param = /:(\w+)/.exec(route.path)?.[1];
      const id = entry.plainQuery === null ? null : options.query.get(entry.plainQuery);
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
export function fixtureSource(fixture: unknown): Source {
  const result =
    typeof fixture === "object" && fixture !== null && "result" in fixture
      ? Promise.resolve(fixture.result)
      : new Promise<never>(() => {});
  return {
    load: () => result,
    call: async (tool) => {
      throw new Error(`The harness has no server to call ${tool}.`);
    },
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
  if (data === null) return error("The tool result does not match the contract.");
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
