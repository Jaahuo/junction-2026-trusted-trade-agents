import type { WholesalerLive } from "@app/contract";
import { env, publicBaseUrl } from "@app/server-kit";
import type { OffersDeps } from "../application/ports.ts";
import { createIssuedOffers, rememberingSigner } from "../application/issued-offers.ts";
import { createQuoteCache } from "../application/quote-cache.ts";
import { envOfferSigner } from "../infra/offer-signer.ts";
import { peerAdapters } from "../infra/peers.ts";
import { FIXTURE_RECORDED_AT, fixtureWholesaler } from "../infra/wholesaler-fixture.ts";
import { mockWholesalerFromEnv } from "../infra/wholesaler-mock.ts";

const NO_PRICE_EFFECT = "get_offers omits every line NO_PRICE and signs no offer.";

export interface LiveSources {
  mock: WholesalerLive | null;
  fixture: () => WholesalerLive;
}

/** The only place that picks the wholesaler adapter; null when no live price source is configured. */
export const selectLive = (
  mode: string | undefined,
  sources: LiveSources,
  warn: (message: string) => void,
): WholesalerLive | null => {
  if (mode === "mock" && sources.mock !== null) return sources.mock;
  if (mode === "fixture") {
    warn(
      `offers: WHOLESALER_LIVE=fixture; prices and availability replay one wholesaler response recorded at ${FIXTURE_RECORDED_AT}, its dates shifted by the days since then. They are not live.`,
    );
    return sources.fixture();
  }
  if (mode === undefined) {
    warn(`offers: WHOLESALER_LIVE is not set; ${NO_PRICE_EFFECT}`);
  } else if (mode === "mock") {
    warn(`offers: WHOLESALER_LIVE=mock has no API key; ${NO_PRICE_EFFECT}`);
  } else {
    warn(
      `offers: WHOLESALER_LIVE="${mode}" is not a live price source (use mock or fixture); ${NO_PRICE_EFFECT}`,
    );
  }
  return null;
};

let memo: OffersDeps | undefined;

/** The process-wide adapters. Building them reads env but calls no peer and loads no key. */
const now = () => new Date();

const buildDeps = (): OffersDeps => {
  const issued = createIssuedOffers();
  return {
    live: selectLive(
      env("WHOLESALER_LIVE"),
      { mock: mockWholesalerFromEnv(), fixture: () => fixtureWholesaler() },
      (message) => console.error(message),
    ),
    ...peerAdapters(),
    signer: rememberingSigner(envOfferSigner(), issued, now),
    cache: createQuoteCache(),
    issued,
    issuer: publicBaseUrl,
    now,
    newOfferId: () => `off_${crypto.randomUUID()}`,
  };
};

export const defaultOffersDeps = (): OffersDeps => (memo ??= buildDeps());
