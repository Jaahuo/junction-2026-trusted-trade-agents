import { offerSigningKeyFromEnv, signOrderReceipt } from "@app/contract/server";
import { err } from "@app/kernel";
import { publicBaseUrl } from "@app/server-kit";
import type { ReceiptSigner } from "../application/ports.ts";

export const envReceiptSigner: ReceiptSigner = async ({
  idempotencyKey: _key,
  requested: _requested,
  ...order
}) => {
  try {
    return await signOrderReceipt(
      { ...order, approvalUrl: null },
      await offerSigningKeyFromEnv(),
      publicBaseUrl(),
    );
  } catch {
    return err("UPSTREAM_FAILED");
  }
};
