import type { WholesalerLive } from "@app/contract";
import { env, publicBaseUrl } from "@app/server-kit";
import type { OffersDeps } from "../application/ports.ts";
import { createQuoteCache } from "../application/quote-cache.ts";
import { envOfferSigner } from "../infra/offer-signer.ts";
import { peerAdapters } from "../infra/peers.ts";
import { fixtureWholesaler } from "../infra/wholesaler-fixture.ts";
import { mockWholesalerFromEnv } from "../infra/wholesaler-mock.ts";

/** The only place that picks the wholesaler adapter; anything but a configured mock uses the fixture. */
export const selectLive = (
  mode: string | undefined,
  mock: WholesalerLive | null,
  warn: (message: string) => void,
): WholesalerLive => {
  if (mode === undefined || mode === "fixture") return fixtureWholesaler();
  if (mode === "mock" && mock !== null) return mock;
  if (mode === "mock") {
    warn("offers: WHOLESALER_LIVE=mock has no API key; using the fixture wholesaler.");
  } else if (mode === "json") {
    warn("offers: WHOLESALER_LIVE=json is not built yet; using the fixture wholesaler.");
  } else {
    warn(`offers: unknown WHOLESALER_LIVE mode "${mode}"; using the fixture wholesaler.`);
  }
  return fixtureWholesaler();
};

let memo: OffersDeps | undefined;

/** The process-wide adapters. Building them reads env but calls no peer and loads no key. */
export const defaultOffersDeps = (): OffersDeps =>
  (memo ??= {
    live: selectLive(env("WHOLESALER_LIVE"), mockWholesalerFromEnv(), (message) =>
      console.error(message),
    ),
    ...peerAdapters(),
    signer: envOfferSigner(),
    cache: createQuoteCache(),
    issuer: publicBaseUrl,
    now: () => new Date(),
    newOfferId: () => `off_${crypto.randomUUID()}`,
  });
