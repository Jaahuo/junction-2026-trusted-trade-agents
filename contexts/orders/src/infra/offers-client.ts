import { callRoute } from "@app/contract/server";
import { err } from "@app/kernel";
import type { RequotePort } from "../application/ports.ts";

/**
 * Re-quotes through the offers API. Offers already depends on orders for its pre-check, so this
 * call goes through callRoute (SPEC-001), not a typed Eden client.
 */
export const offersClient: RequotePort = {
  requote: async (request) => {
    const result = await callRoute("requote", request);
    if (result.ok) return result;
    if (result.error === "BAD_REQUEST") return err("BAD_REQUEST");
    console.error("The offers could not be re-quoted.", { code: result.error });
    return err("UPSTREAM_FAILED");
  },
};
