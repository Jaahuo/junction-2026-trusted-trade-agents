import {
  localOfferKeys,
  type OfferKeySet,
  offerSigningKeyFromEnv,
  verifyOfferToken,
} from "@app/contract/server";
import type { OfferVerifier } from "../application/ports.ts";

export const offerVerifier =
  (keys: () => Promise<OfferKeySet>): OfferVerifier =>
  async (token, now) =>
    verifyOfferToken(token, await keys(), now);

/** Offers are signed in this process, so orders verify with the public part of the same key. */
export const processOfferVerifier = (): OfferVerifier => {
  let keys: Promise<OfferKeySet> | undefined;
  return offerVerifier(() => {
    keys ??= offerSigningKeyFromEnv().then((key) => localOfferKeys({ keys: [key.publicJwk] }));
    return keys;
  });
};
