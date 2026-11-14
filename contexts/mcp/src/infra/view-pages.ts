import { err, ok } from "@app/kernel";
import { selfBaseUrl } from "@app/server-kit";
import type { ViewPages } from "../application/tools.ts";

// `GET /views/:view` is a root route of the views context, so no Eden `Api` type covers it.
export const httpViewPages = (
  baseUrl: () => string = selfBaseUrl,
  fetcher: typeof fetch = fetch,
): ViewPages => ({
  html: async (view) => {
    try {
      const response = await fetcher(`${baseUrl()}/views/${encodeURIComponent(view)}`);
      if (response.status === 404) return err("NOT_FOUND");
      if (!response.ok) return err("UPSTREAM_FAILED");
      return ok(await response.text());
    } catch {
      return err("UPSTREAM_FAILED");
    }
  },
});
