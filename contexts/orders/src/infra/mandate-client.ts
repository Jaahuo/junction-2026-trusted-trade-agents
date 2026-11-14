import { MandateSchema } from "@app/contract";
import { err, ok } from "@app/kernel";
import type { Api } from "@ctx/mandates/api";
import { treaty } from "@elysia/eden";
import type { MandatePort } from "../application/ports.ts";

/**
 * Reads the current mandate through the mandates API: a URL in the server, an app instance in tests.
 * 404 means no current mandate; any other failure is an upstream failure.
 */
export const mandateClient = (target: string | Api): MandatePort => {
  const client = treaty<Api>(target, { parseDate: false });
  return {
    current: async () => {
      try {
        const { data, status } = await client.mandates.current.get();
        if (status === 404) return ok(null);
        const parsed = MandateSchema.safeParse(data?.mandate);
        return parsed.success ? ok(parsed.data) : err("UPSTREAM_FAILED");
      } catch (error) {
        console.error(`The current mandate could not be read: ${String(error)}`);
        return err("UPSTREAM_FAILED");
      }
    },
  };
};
