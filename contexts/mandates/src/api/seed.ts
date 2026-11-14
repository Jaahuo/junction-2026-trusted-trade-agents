import { DEMO_ACCOUNT, type RegisterMandateRequest } from "@app/contract";
import type { Db } from "@app/server-kit";
import { registerMandate } from "../application/mandates.ts";
import { buyerSigner } from "../infra/buyer-key.ts";
import { postgresMandateStore } from "../infra/mandate-store.ts";

/** The demo mandate of SPEC-015. */
const demoMandateRequest: RegisterMandateRequest = {
  limits: {
    maxOrderTotal: { value: 1000, currency: "EUR", basis: "gross" },
    categories: null,
    substitutions: "ask",
    newProducts: "ask",
    minDeliveryReliability: { value: 0.9, ifNoData: "auto" },
    maxCo2PerKg: { value: 3, ifNoData: "auto" },
    allergenData: { ifNoData: "ask" },
    paymentTerms: { invoice: "auto", pay_on_order: "ask" },
  },
  standingConstraints: { hard: [], soft: [{ attribute: "countryOfOrigin", prefer: "fi" }] },
};

export const seed = async (db: Db): Promise<void> => {
  const result = await registerMandate(
    { store: postgresMandateStore(db), sign: buyerSigner() },
    DEMO_ACCOUNT,
    demoMandateRequest,
    new Date(),
  );
  if (!result.ok) throw new Error("The demo mandate expiry is invalid.");
};
