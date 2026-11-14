import { callRoute } from "@app/contract/server";
import { err, ok } from "@app/kernel";
import type { IssuedOfferPort, RequotePort } from "../application/ports.ts";

/**
 * Re-quotes through the offers API. Offers already depends on orders for its pre-check, so this
 * call goes through callRoute (SPEC-001), not a typed Eden client.
 */
export const offersClient: RequotePort & IssuedOfferPort = {
  requote: async (request) => {
    const result = await callRoute("requote", request);
    if (result.ok) return result;
    if (result.error === "BAD_REQUEST") return err("BAD_REQUEST");
    console.error("The offers could not be re-quoted.", { code: result.error });
    return err("UPSTREAM_FAILED");
  },
  issued: async (offerIds) => {
    const result = await callRoute("issued", { offerIds });
    if (result.ok)
      return ok(new Map(result.value.offers.map((offer) => [offer.offerId, offer.token])));
    console.error("The issued offers could not be read.", { code: result.error });
    return err("UPSTREAM_FAILED");
  },
};
