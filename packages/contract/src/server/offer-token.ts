import type { Result } from "@app/kernel";
import type { OfferClaims } from "../offers.ts";
import { notImplemented } from "./not-implemented.ts";

export interface OfferSigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}
export type OfferKeySet = (kid: string) => Promise<CryptoKey | null>;

export const offerSigningKeyFromEnv = async (): Promise<OfferSigningKey> => notImplemented();

export const localOfferKeys = (_jwks: { keys: JsonWebKey[] }): OfferKeySet => notImplemented();

/** Caches; refetches once on an unknown kid. */
export const remoteOfferKeys = (_jwksUrl: URL): OfferKeySet => notImplemented();

export const signOfferToken = async (
  _claims: Omit<OfferClaims, "iat" | "exp">,
  _key: OfferSigningKey,
  _exp: Date,
): Promise<string> => notImplemented();

export const verifyOfferToken = async (
  _token: string,
  _keys: OfferKeySet,
  _now?: Date,
): Promise<
  Result<OfferClaims, { code: "OFFER_INVALID" } | { code: "OFFER_EXPIRED"; claims: OfferClaims }>
> => notImplemented();
