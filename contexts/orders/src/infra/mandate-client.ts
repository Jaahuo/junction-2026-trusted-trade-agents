import { ErrorEnvelopeSchema, MandateSchema } from "@app/contract";
import { err, ok } from "@app/kernel";
import type { Api } from "@ctx/mandates/api";
import { treaty } from "@elysia/eden";
import type { MandatePort } from "../application/ports.ts";

const TIMEOUT_MS = 10_000;

/**
 * Reads the current mandate through the mandates API: a URL in the server, an app instance in tests.
 * Only the route's own NOT_FOUND envelope means "no current mandate"; any other answer, a body that
 * fails the schema or a timeout is an upstream failure, so a misrouted call never reads as "none".
 * A mandate of another agent is not this agent's mandate. `fetcher` replaces the network in tests.
 */
export const mandateClient = (
  target: string | Api,
  options: { fetcher?: typeof fetch } = {},
): MandatePort => {
  const client = treaty<Api>(target, { parseDate: false, ...options });
  return {
    current: async (agentId) => {
      try {
        const { data, error, status } = await client.mandates.current.get({
          fetch: { signal: AbortSignal.timeout(TIMEOUT_MS) },
        });
        if (
          status === 404 &&
          ErrorEnvelopeSchema.safeParse(error?.value).data?.error.code === "NOT_FOUND"
        )
          return ok(null);
        const parsed = MandateSchema.safeParse(data?.mandate);
        if (!parsed.success) {
          console.error("The current mandate could not be read.", {
            status,
            issues: parsed.error.issues.slice(0, 3),
          });
          return err("UPSTREAM_FAILED");
        }
        return ok(parsed.data.agent === agentId ? parsed.data : null);
      } catch (error) {
        console.error("The current mandate could not be read.", error);
        return err("UPSTREAM_FAILED");
      }
    },
  };
};
