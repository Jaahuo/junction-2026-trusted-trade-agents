import { localOfferKeys, verifyOfferToken } from "@app/contract/server";
import type { OfferSigner } from "../application/ports.ts";
import type { OwnOfferClaims } from "../application/requote.ts";

/** Verifies a token against this server's own published key; an expired token keeps its claims. */
export const ownOfferClaims =
  (signer: OfferSigner, now: () => Date): OwnOfferClaims =>
  async (token) => {
    const verified = await verifyOfferToken(token, localOfferKeys(await signer.jwks()), now());
    if (verified.ok) return verified.value;
    return verified.error.code === "OFFER_EXPIRED" ? verified.error.claims : null;
  };
