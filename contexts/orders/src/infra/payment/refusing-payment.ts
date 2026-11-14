import { err } from "@app/kernel";
import type { PaymentPort } from "../../application/ports.ts";

/** First build: only invoice terms reach placement, so pay-on-order is refused (SPEC-010). */
export const refusingPayment: PaymentPort = {
  authorize: async () => err("PAYMENT_FAILED"),
};
