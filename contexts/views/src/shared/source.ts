import { VIEWS } from "@app/contract";
import { App } from "@modelcontextprotocol/ext-apps";
import { fixtureSource, hostSource, plainSource, type Source, type ViewName } from "./bridge.ts";

export type { Source } from "./bridge.ts";

/** Host mode: the MCP Apps bridge (SPEC-013). */
function bridgeSource(view: ViewName): Source {
  const app = new App({ name: `trusted-trade-${view}`, version: "1.0.0" });
  // The tool-result handler is set before connecting, so no result is missed.
  const source = hostSource({
    onToolResult: (listener) => {
      app.ontoolresult = (params) => listener(params.structuredContent);
    },
    onToolInput: (listener) => {
      app.ontoolinput = (params) => listener(params.arguments ?? {});
    },
    callServerTool: async (request) => {
      await ready;
      const result = await app.callServerTool(request);
      const text = result.content.find((item) => item.type === "text")?.text;
      return {
        isError: result.isError === true,
        structuredContent: result.structuredContent,
        ...(text === undefined ? {} : { text }),
      };
    },
    sendMessage: async (text) => {
      await ready;
      const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      return result.isError !== true;
    },
    updateModelContext: async (text) => {
      await ready;
      await app.updateModelContext({ content: [{ type: "text", text }] });
    },
  });
  const ready = app.connect();
  return source;
}

/**
 * The harness injects a fixture; embedded views use the host bridge. A top-level
 * view loads its plain REST route when it has the required data.
 */
export function sourceFor(view: ViewName): Source {
  const fixture = document.querySelector("#tt-harness")?.textContent;
  if (fixture) return fixtureSource(JSON.parse(fixture));
  if (window.parent === window) {
    const entry = VIEWS.find((candidate) => candidate.view === view);
    const query = new URLSearchParams(location.search);
    // A page opened in the browser calls the API on its own origin (the API, or the web app's
    // proxy), which stays right even when PUBLIC_BASE_URL points elsewhere.
    const source = plainSource(view, {
      fetch: (url, init) => fetch(url, init),
      baseUrl: location.origin,
      query,
    });
    if (
      entry?.plainLoad != null &&
      (entry.plainQuery === null || query.get(entry.plainQuery)?.trim() || entry.plainList !== null)
    )
      return source;
    return Object.assign(source, { standaloneFallback: true });
  }
  return bridgeSource(view);
}
