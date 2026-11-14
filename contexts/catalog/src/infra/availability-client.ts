import { callRoute } from "@app/contract/server";
import { err, ok } from "@app/kernel";
import type { AvailabilitySource } from "../application/catalog.ts";

/**
 * Reads live availability through the offers API. Offers already depends on catalog for product
 * facts, so this call goes through callRoute (SPEC-001), not a typed Eden client.
 */
export const offersAvailability: AvailabilitySource = {
  deliverable: async (deliverBy, productIds) => {
    const result = await callRoute("availability", { deliverBy, productIds: [...productIds] });
    if (result.ok) return ok(new Set(result.value.deliverable));
    console.error("catalog: availability could not be read.", { code: result.error });
    return err("UPSTREAM_FAILED");
  },
};
