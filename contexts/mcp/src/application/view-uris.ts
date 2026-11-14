import { VIEWS } from "@app/contract";
import { versionedViewUri, viewVersion } from "../domain/view-uri.ts";
import type { ViewName, ViewPages } from "./tools.ts";

/** The URI the server announces for each view (SPEC-013). */
export interface ViewUris {
  uri(view: ViewName): Promise<string>;
}

const baseUri = (view: ViewName): string => {
  const entry = VIEWS.find((candidate) => candidate.view === view);
  if (entry === undefined) throw new Error(`${view} is not in VIEWS.`);
  return entry.uri;
};

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Versions each view by the hash of its HTML, once per instance and view.
 * A view it cannot fetch keeps the base URI and is fetched again next time.
 */
export const viewUris = (views: ViewPages): ViewUris => {
  const known = new Map<ViewName, string>();
  return {
    uri: async (view) => {
      const cached = known.get(view);
      if (cached !== undefined) return cached;
      const html = await views.html(view);
      if (!html.ok) return baseUri(view);
      const uri = versionedViewUri(baseUri(view), viewVersion(await sha256Hex(html.value)));
      known.set(view, uri);
      return uri;
    },
  };
};
