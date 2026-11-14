import { TOOL_INPUT } from "@app/contract";
import { createHash } from "node:crypto";

export const placeOrderInput = TOOL_INPUT.place_order
  .omit({ idempotencyKey: true })
  .transform((request) => ({
    ...request,
    idempotencyKey: `mcp-order-v1-${createHash("sha256")
      .update(
        JSON.stringify([
          request.offers,
          request.alternatives ?? [],
          request.supersedes?.orderId ?? null,
          request.supersedes?.proposalVersion ?? null,
        ]),
      )
      .digest("hex")}`,
  }));
