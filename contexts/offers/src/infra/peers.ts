import {
  ErrorEnvelopeSchema,
  type FactsRequest,
  FactsResultSchema,
  PrecheckSchema,
  StoredMandateSchema,
} from "@app/contract";
import { err, ok } from "@app/kernel";
import { selfBaseUrl } from "@app/server-kit";
import type { Api as CatalogApi } from "@ctx/catalog/api";
import type { Api as MandatesApi } from "@ctx/mandates/api";
import type { Api as OrdersApi } from "@ctx/orders/api";
import { treaty } from "@elysia/eden";
import type { CatalogFacts, CurrentMandate, Prechecker } from "../application/ports.ts";

export const PRECHECK_TIMEOUT_MS = 2000;

export interface PeerOptions {
  fetcher?: typeof fetch;
  baseUrl?: () => string;
  precheckTimeoutMs?: number;
}

// The only answers that mean "no mandate": the error envelope of an absent or unimplemented mandate.
const NO_MANDATE = new Map<number, string>([
  [404, "NOT_FOUND"],
  [501, "NOT_IMPLEMENTED"],
]);

const log = (message: string): void => console.error(`offers: ${message}`);

/** Calls catalog facts, the current mandate and orders precheck over HTTP (SPEC-001). */
export const peerAdapters = (
  options: PeerOptions = {},
): { catalog: CatalogFacts; mandates: CurrentMandate; orders: Prechecker } => {
  const { fetcher, baseUrl = selfBaseUrl, precheckTimeoutMs = PRECHECK_TIMEOUT_MS } = options;
  const config = (): { parseDate: false; fetcher?: typeof fetch } => ({
    parseDate: false,
    ...(fetcher === undefined ? {} : { fetcher }),
  });
  const apiUrl = (): string => `${baseUrl()}/api`;

  const catalog: CatalogFacts = {
    facts: async (req: FactsRequest) => {
      try {
        const { data, error } = await treaty<CatalogApi>(apiUrl(), config()).catalog.facts.post(
          req,
        );
        if (error !== null) {
          log(`catalog facts answered ${error.status}`);
          return err("UPSTREAM_FAILED");
        }
        const parsed = FactsResultSchema.safeParse(data);
        if (parsed.success) return ok(parsed.data);
        log(`catalog facts answered an invalid body: ${parsed.error.message}`);
      } catch (error) {
        log(`catalog facts call failed: ${String(error)}`);
      }
      return err("UPSTREAM_FAILED");
    },
  };

  const mandates: CurrentMandate = {
    current: async () => {
      try {
        const { data, error } = await treaty<MandatesApi>(
          apiUrl(),
          config(),
        ).mandates.current.get();
        if (error !== null) {
          const status: number = error.status;
          const envelope = ErrorEnvelopeSchema.safeParse(error.value);
          if (envelope.success && NO_MANDATE.get(status) === envelope.data.error.code) {
            return ok(null);
          }
          log(`mandates current answered ${status}`);
          return err("UPSTREAM_FAILED");
        }
        const parsed = StoredMandateSchema.safeParse(data);
        if (parsed.success) return ok(parsed.data.mandate);
        log(`mandates current answered an invalid body: ${parsed.error.message}`);
      } catch (error) {
        log(`mandates current call failed: ${String(error)}`);
      }
      return err("UPSTREAM_FAILED");
    },
  };

  const orders: Prechecker = {
    precheck: async (token: string) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("timeout");
        }, precheckTimeoutMs);
      });
      try {
        const call = treaty<OrdersApi>(apiUrl(), config()).orders.precheck.post(
          { offers: [token] },
          { fetch: { signal: controller.signal } },
        );
        // A late rejection of the abandoned call must not surface as unhandled.
        call.catch(() => undefined);
        const response = await Promise.race([call, deadline]);
        if (response === "timeout") {
          log(`orders precheck did not answer within ${precheckTimeoutMs} ms`);
          return err("UNAVAILABLE");
        }
        if (response.error !== null) {
          log(`orders precheck answered ${response.error.status}`);
          return err("UNAVAILABLE");
        }
        const parsed = PrecheckSchema.safeParse(response.data);
        if (parsed.success) return ok(parsed.data);
        log(`orders precheck answered an invalid body: ${parsed.error.message}`);
      } catch (error) {
        log(`orders precheck call failed: ${String(error)}`);
      } finally {
        clearTimeout(timer);
      }
      return err("UNAVAILABLE");
    },
  };

  return { catalog, mandates, orders };
};
