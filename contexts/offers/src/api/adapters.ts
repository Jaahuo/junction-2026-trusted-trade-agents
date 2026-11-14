import type { WholesalerLive } from "@app/contract";
import { env, publicBaseUrl } from "@app/server-kit";
import type { OffersDeps } from "../application/ports.ts";
import { createIssuedOffers, rememberingSigner } from "../application/issued-offers.ts";
import { createQuoteCache } from "../application/quote-cache.ts";
import { envOfferSigner } from "../infra/offer-signer.ts";
import { peerAdapters } from "../infra/peers.ts";
import { mockWholesalerFromEnv } from "../infra/wholesaler-mock.ts";

const NO_PRICE_EFFECT = "get_offers omits every line NO_PRICE and signs no offer.";

/** The only place that picks the wholesaler adapter; null when no live price source is configured. */
export const selectLive = (
  mode: string | undefined,
  mock: WholesalerLive | null,
  warn: (message: string) => void,
): WholesalerLive | null => {
  if (mode === "mock" && mock !== null) return mock;
  if (mode === undefined) {
    warn(`offers: WHOLESALER_LIVE is not set; ${NO_PRICE_EFFECT}`);
  } else if (mode === "mock") {
    warn(`offers: WHOLESALER_LIVE=mock has no API key; ${NO_PRICE_EFFECT}`);
  } else {
    warn(`offers: WHOLESALER_LIVE="${mode}" is not a live price source; ${NO_PRICE_EFFECT}`);
  }
  return null;
};

let memo: OffersDeps | undefined;

/** The process-wide adapters. Building them reads env but calls no peer and loads no key. */
const now = () => new Date();

const buildDeps = (): OffersDeps => {
  const issued = createIssuedOffers();
  return {
    live: selectLive(env("WHOLESALER_LIVE"), mockWholesalerFromEnv(), (message) =>
      console.error(message),
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
