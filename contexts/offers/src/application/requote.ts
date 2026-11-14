import { err, ok, type Result } from "@app/kernel";
import type {
  OfferClaims,
  OfferLine,
  OffersResult,
  Principal,
  RequoteRequest,
} from "@app/contract";
import { getOffers, type GetOffersError } from "./get-offers.ts";
import type { OffersDeps } from "./ports.ts";

const badRequest = (message: string): Result<never, GetOffersError> =>
  err({ code: "BAD_REQUEST", message });

/** The claims of a token this server signed, expired or not; null when it fails verification. */
export type OwnOfferClaims = (token: string) => Promise<OfferClaims | null>;

const claimsOf = async (
  verify: OwnOfferClaims,
  tokens: string[],
): Promise<Result<OfferClaims[], GetOffersError>> => {
  const claims: OfferClaims[] = [];
  for (const token of tokens) {
    const verified = await verify(token);
    if (verified === null) return badRequest("An offer token failed verification.");
    claims.push(verified);
  }
  return ok(claims);
};

/**
 * A substitute keeps naming the product it replaces, so its approval rule still applies. The fresh
 * offer is signed again with that link; its pre-check was made without it, so it is dropped.
 */
const relink = async (deps: OffersDeps, offer: OfferLine, replaces: string): Promise<OfferLine> => {
  const { iat: _iat, exp, ...claims } = offer.claims;
  const minted = await deps.signer.sign(
    { ...claims, offerId: deps.newOfferId(), replaces },
    new Date(exp * 1000),
  );
  return {
    offerId: minted.claims.offerId,
    token: minted.token,
    claims: minted.claims,
    precheck: null,
    rank: null,
    comparison: null,
  };
};

/**
 * SPEC-006 `requote`: a new offer for the product, quantity and date of each token, or the given
 * changes, under the current mandate, through the same steps as `get_offers`. One offer per token,
 * in token order, or an omitted entry with the reason. No new substitutes are proposed.
 */
export async function requote(
  deps: OffersDeps,
  principal: Principal,
  req: RequoteRequest,
  verify: OwnOfferClaims,
): Promise<Result<OffersResult, GetOffersError>> {
  const sources = await claimsOf(verify, req.tokens);
  if (!sources.ok) return sources;
  if (
    sources.value.some(
      (claims) => claims.customer !== principal.customer || claims.agentId !== principal.agentId,
    )
  )
    return badRequest("An offer was issued to another customer or agent.");
  const changes = new Map((req.changes ?? []).map((change) => [change.productId, change]));
  if (changes.size !== (req.changes ?? []).length)
    return badRequest("A product is changed more than once.");
  const products = new Set(sources.value.map((claims) => claims.productId));
  if ([...changes.keys()].some((productId) => !products.has(productId)))
    return badRequest("A change names a product that none of the tokens offers.");

  const offers: OfferLine[] = [];
  const omitted: OffersResult["omitted"] = [];
  for (const claims of sources.value) {
    const change = changes.get(claims.productId);
    const result = await getOffers(deps, principal, {
      lines: [{ productId: claims.productId, quantity: change?.quantity ?? claims.quantity }],
      deliverBy: change?.deliverBy ?? claims.requestedDate,
      paymentTerms: claims.paymentTerms,
      hard: claims.constraints.hard,
      soft: claims.constraints.soft,
    });
    if (!result.ok) return result;
    omitted.push(...result.value.omitted);
    const fresh = result.value.offers.find((offer) => offer.claims.replaces === null);
    if (fresh === undefined) continue;
    offers.push(claims.replaces === null ? fresh : await relink(deps, fresh, claims.replaces));
  }
  return ok({ offers, omitted });
}
