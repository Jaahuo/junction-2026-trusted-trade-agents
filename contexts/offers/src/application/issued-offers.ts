import type { OfferClaims } from "@app/contract";
import type { IssuedOffers, OfferSigner } from "./ports.ts";

interface Entry {
  customer: string;
  agentId: string;
  token: string;
  /** Unix seconds, the token's own `exp`. */
  exp: number;
}

/** Sweeps expired entries once per this many new ones, so the map holds about the live offers. */
const SWEEP_EVERY = 256;

/**
 * The tokens this process signed, by offer ID, until they expire (SPEC-006 `issued`). An agent can
 * then name an offer by its short ID instead of copying the token. Process memory: a restart forgets
 * the IDs, and the agent requests new offers or sends the token.
 */
export function createIssuedOffers(): IssuedOffers {
  const entries = new Map<string, Entry>();
  let added = 0;
  const sweep = (nowSeconds: number) => {
    for (const [offerId, entry] of entries) if (entry.exp <= nowSeconds) entries.delete(offerId);
  };
  return {
    remember(token: string, claims: OfferClaims, now: Date) {
      entries.set(claims.offerId, {
        customer: claims.customer,
        agentId: claims.agentId,
        token,
        exp: claims.exp,
      });
      added += 1;
      if (added % SWEEP_EVERY === 0) sweep(now.getTime() / 1000);
    },
    find(principal, offerIds, now) {
      const nowSeconds = now.getTime() / 1000;
      return offerIds.flatMap((offerId) => {
        const entry = entries.get(offerId);
        if (
          entry === undefined ||
          entry.exp <= nowSeconds ||
          entry.customer !== principal.customer ||
          entry.agentId !== principal.agentId
        )
          return [];
        return [{ offerId, token: entry.token }];
      });
    },
  };
}

/** A signer that remembers every token it signs, so get_offers and requote both fill the store. */
export const rememberingSigner = (
  signer: OfferSigner,
  issued: IssuedOffers,
  now: () => Date,
): OfferSigner => ({
  async sign(claims, exp) {
    const minted = await signer.sign(claims, exp);
    issued.remember(minted.token, minted.claims, now());
    return minted;
  },
  jwks: () => signer.jwks(),
});
