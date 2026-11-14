import type { Result } from "@app/kernel";
import type {
  FactsRequest,
  FactsResult,
  Mandate,
  OfferClaims,
  Precheck,
  PriceQuote,
  WholesalerLive,
} from "@app/contract";

export type PublicJwk = JsonWebKey & { kid: string };
export interface CatalogFacts {
  facts(req: FactsRequest): Promise<Result<FactsResult, "UPSTREAM_FAILED">>;
}
export interface CurrentMandate {
  current(): Promise<Result<Mandate | null, "UPSTREAM_FAILED">>;
}
export interface Prechecker {
  precheck(token: string): Promise<Result<Precheck, "UNAVAILABLE">>;
}
export interface OfferSigner {
  /** claims = the payload decoded from the minted token, so iat and exp are the token's own. */
  sign(
    claims: Omit<OfferClaims, "iat" | "exp">,
    exp: Date,
  ): Promise<{ token: string; claims: OfferClaims }>;
  jwks(): Promise<{ keys: PublicJwk[] }>;
}
/** requestedDate = the pricing date, which is the delivery date the price was read for. */
export interface PriceKey {
  customer: string;
  requestedDate: string;
  productId: string;
}
/** Prices only: availability is always read live (SPEC-005). */
export interface QuoteCache {
  get(key: PriceKey, now: Date): PriceQuote | undefined;
  set(key: PriceKey, price: PriceQuote, expiresAt: Date): void;
}
/** The tokens this service issued, by offer ID, until they expire (SPEC-006 `issued`). */
export interface IssuedOffers {
  remember(token: string, claims: OfferClaims, now: Date): void;
  /** The unexpired tokens issued to this customer and agent; an unknown ID is left out. */
  find(
    principal: { customer: string; agentId: string },
    offerIds: readonly string[],
    now: Date,
  ): { offerId: string; token: string }[];
}
export interface OffersDeps {
  /** null: no live price source is configured, so no line can be priced. */
  live: WholesalerLive | null;
  catalog: CatalogFacts;
  mandates: CurrentMandate;
  orders: Prechecker;
  signer: OfferSigner;
  cache: QuoteCache;
  issued: IssuedOffers;
  issuer: () => string;
  now: () => Date;
  newOfferId: () => string;
}
