import { err, ok } from "@app/kernel";
import type { Api } from "@ctx/mandates/api";
import { treaty } from "@elysia/eden";
import type { MandateSource } from "../application/catalog.ts";

type Fetcher = NonNullable<Parameters<typeof treaty>[1]>["fetcher"];

/** Reads the current mandate through the mandates API (SPEC-001). 404 or 501 means no mandate. */
export const edenMandateSource = (apiBaseUrl: () => string, fetcher?: Fetcher): MandateSource => ({
  current: async () => {
    const api = treaty<Api>(apiBaseUrl(), {
      parseDate: false,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
    let response;
    try {
      response = await api.mandates.current.get();
    } catch (error) {
      console.error(`catalog: mandates call failed: ${String(error)}`);
      return err("UPSTREAM_FAILED");
    }
    const { data, error } = response;
    if (data !== null) {
      const { mandateId, version, standingConstraints } = data.mandate;
      return ok({ id: mandateId, version, standingConstraints });
    }
    const status: number | undefined = error?.status;
    return status === 404 || status === 501 ? ok(null) : err("UPSTREAM_FAILED");
  },
});
