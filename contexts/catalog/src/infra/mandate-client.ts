import { ErrorEnvelopeSchema, StoredMandateSchema } from "@app/contract";
import { err, ok } from "@app/kernel";
import type { Api } from "@ctx/mandates/api";
import { treaty } from "@elysia/eden";
import type { MandateSource } from "../application/catalog.ts";

type Fetcher = NonNullable<Parameters<typeof treaty>[1]>["fetcher"];

// The only answers that mean "no mandate": 404 NOT_FOUND and 501 NOT_IMPLEMENTED in the error envelope.
const NO_MANDATE = new Map<number, string>([
  [404, "NOT_FOUND"],
  [501, "NOT_IMPLEMENTED"],
]);

/** Reads the current mandate through the mandates API (SPEC-001). Any answer outside the contract is UPSTREAM_FAILED. */
export const edenMandateSource = (apiBaseUrl: () => string, fetcher?: Fetcher): MandateSource => ({
  current: async () => {
    let response;
    try {
      const api = treaty<Api>(apiBaseUrl(), {
        parseDate: false,
        ...(fetcher === undefined ? {} : { fetcher }),
      });
      response = await api.mandates.current.get();
    } catch (error) {
      console.error(`catalog: mandates call failed: ${String(error)}`);
      return err("UPSTREAM_FAILED");
    }
    const { data, error } = response;
    if (error === null) {
      // Eden does not validate a 2xx body against the route schema.
      const stored = StoredMandateSchema.safeParse(data);
      if (!stored.success) {
        console.error(`catalog: mandates answered an invalid body: ${stored.error.message}`);
        return err("UPSTREAM_FAILED");
      }
      const { mandateId, version, standingConstraints } = stored.data.mandate;
      return ok({ id: mandateId, version, standingConstraints });
    }
    const status: number = error.status;
    const envelope = ErrorEnvelopeSchema.safeParse(error.value);
    if (envelope.success && NO_MANDATE.get(status) === envelope.data.error.code) return ok(null);
    console.error(`catalog: mandates answered ${status} outside the contract`);
    return err("UPSTREAM_FAILED");
  },
});
