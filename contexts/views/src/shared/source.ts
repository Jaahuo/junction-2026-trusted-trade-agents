import { VIEWS } from "@app/contract";
import { App } from "@modelcontextprotocol/ext-apps";
import { fixtureSource, hostSource, plainSource, type Source, type ViewName } from "./bridge.ts";

export type { Source } from "./bridge.ts";

/** The server's public base URL, which the API writes into each view it serves. */
const baseUrl = () =>
  document.querySelector<HTMLMetaElement>('meta[name="tt-base-url"]')?.content ?? location.origin;

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
      return { isError: result.isError === true, structuredContent: result.structuredContent };
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
 * The harness (`/views/harness`) injects a fixture; a top-level page of a view with
 * `plainLoad` is plain mode; anything else runs inside an MCP Apps host.
 */
export function sourceFor(view: ViewName): Source {
  const fixture = document.querySelector("#tt-harness")?.textContent;
  if (fixture) return fixtureSource(JSON.parse(fixture));
  const plain = VIEWS.find((entry) => entry.view === view)?.plainLoad != null;
  if (plain && window.parent === window)
    return plainSource(view, {
      fetch: (url, init) => fetch(url, init),
      baseUrl: baseUrl(),
      query: new URLSearchParams(location.search),
    });
  return bridgeSource(view);
}
