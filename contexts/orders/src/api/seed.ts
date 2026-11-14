import {
  DEMO_ACCOUNT,
  type DemoProducts,
  DemoProductsSchema,
  type Mandate,
  type OfferClaims,
  fixtures,
  type Quantity,
} from "@app/contract";
import {
  localOfferKeys,
  offerSigningKeyFromEnv,
  signOfferToken,
  signOrderReceipt,
} from "@app/contract/server";
import { type Db, type SeedInputs } from "@app/server-kit";
import type { HistoryRow } from "../domain/evaluate.ts";
import { decide } from "../application/approvals.ts";
import { appendOrderAudit } from "../application/commit-placement.ts";
import { placeOrder } from "../application/orders.ts";
import type { StoredOrder } from "../application/ports.ts";
import { mandateClient } from "../infra/mandate-client.ts";
import { offerVerifier } from "../infra/offer-verifier.ts";
import { offersClient } from "../infra/offers-client.ts";
import { refusingPayment } from "../infra/payment/refusing-payment.ts";
import { postgresOrderStore } from "../infra/order-store.ts";
import { history } from "../infra/schema.ts";

const times = (rows: number, productId: string, quantity: Quantity): HistoryRow[] =>
  Array.from({ length: rows }, () => ({ productId, quantity }));

const fifth = (quantity: Quantity): Quantity => ({
  value: Math.ceil(quantity.value / 5),
  unit: quantity.unit,
});

/** Approvals of the scenario 3 substitute before the demo; the next one offers a standing rule. */
const EARLIER_APPROVALS = 2;

// Earlier approvals must keep the real pair without displaying imported product identifiers.
const approvedSubstitute = (
  demo: DemoProducts,
  replaces: string,
  productId: string,
  quantity: Quantity,
  index: number,
): StoredOrder => {
  const at = demo.observedAt;
  const claims = {
    ...fixtures.offerClaims,
    offerId: `off_seed_substitute_${index}`,
    productId,
    quantity,
    replaces,
    deliveryDate: demo.requestedDate,
    requestedDate: demo.requestedDate,
    product: { ...fixtures.offerClaims.product, name: "Demo earlier approved substitute" },
  };
  return {
    ...fixtures.order,
    orderId: `ord_seed_substitute_${index}`,
    idempotencyKey: `seed-substitute-${index}`,
    requested: { offers: [], alternatives: [] },
    offerIds: [claims.offerId],
    lines: [{ offerId: claims.offerId, token: "seed", claims }],
    status: "placed",
    reasons: ["SUBSTITUTION"],
    total: claims.total,
    originalRequest: null,
    decision: { action: "approve", next: null, note: null, by: DEMO_ACCOUNT.accountId, at },
    nextDeliveryDate: null,
    audit: [
      { at, actor: "agent", event: "order_requested" },
      { at, actor: "server", event: "sent_to_approval", reason: "SUBSTITUTION" },
      { at, actor: "approver", event: "approved" },
      { at, actor: "server", event: "placed" },
    ],
    createdAt: at,
  };
};

/**
 * Order history of the demo customer (SPEC-015), so scenario 1 gives no reason and scenario 2 only
 * the spend limit: three rows of the scenario 1 quantity, three of a fifth of the larger requests.
 * With a scenario 3 substitute, two approved orders of it, so the demo's approval is the third.
 */
export const seedHistory = async (
  db: Db,
  options: { demo?: unknown; warn?: (message: string) => void } = {},
): Promise<void> => {
  const warn = options.warn ?? console.error;
  if (options.demo === undefined || options.demo === null) {
    warn("No imported demo metadata, so the demo customer gets no order history.");
    return;
  }
  const demo = DemoProductsSchema.parse(options.demo);
  const rows = [
    ...times(3, demo.s1.productId, demo.s1.quantity),
    ...times(3, demo.s2.productId, fifth(demo.s2.quantity)),
    ...(demo.s3 === null ? [] : times(3, demo.s3.productId, fifth(demo.s3.quantity))),
  ];
  const substitute = demo.s3Substitute;
  if (demo.s3 !== null && substitute !== undefined) {
    const replaces = demo.s3.productId;
    const amount = fifth(demo.s3.quantity);
    // History, so the substitute is not a new product, and two approvals of the pair.
    rows.push(...times(EARLIER_APPROVALS, substitute.productId, amount));
    const store = postgresOrderStore(db);
    await store.withCustomerLock(DEMO_ACCOUNT.customer, async (tx) => {
      for (let index = 1; index <= EARLIER_APPROVALS; index++) {
        const order = approvedSubstitute(demo, replaces, substitute.productId, amount, index);
        // The audit is hash-chained like every stored order's, so its log shows as intact.
        const chained = await appendOrderAudit(order, order.audit, true);
        if (!chained.ok) throw new Error("The seeded order audit could not be chained.");
        await tx.insert(chained.value);
      }
    });
  }
  const placedAt = new Date(demo.observedAt);
  await db.insert(history).values(
    rows.map(({ productId, quantity }) => ({
      customer: DEMO_ACCOUNT.customer,
      productId,
      quantity,
      placedAt,
    })),
  );
};

/** Invented activity, independent of the imported catalogue and scenario history. */
const seedActivity = async (db: Db, mandate: Mandate, fetcher: typeof fetch): Promise<void> => {
  const now = new Date();
  const expiry = new Date(now.getTime() + 28 * 86_400_000);
  const cutoff = new Date(now.getTime() + 29 * 86_400_000).toISOString();
  const delivery = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const key = await offerSigningKeyFromEnv();
  const keys = localOfferKeys({ keys: [key.publicJwk] });
  const deps = {
    store: postgresOrderStore(db),
    verifyOffer: offerVerifier(async () => keys),
    issuedOffers: offersClient,
    offers: offersClient,
    mandates: mandateClient("http://seed.local/api", { fetcher }),
    payment: refusingPayment,
    signReceipt: ({ idempotencyKey: _key, requested: _requested, ...order }: StoredOrder) =>
      signOrderReceipt({ ...order, approvalUrl: null }, key, "http://seed.local"),
    now: () => new Date(),
  };

  for (const kind of ["placed", "pending"] as const) {
    const total = kind === "placed" ? 10 : Math.ceil(mandate.limits.maxOrderTotal.value) + 100;
    const unsigned: Omit<OfferClaims, "iat" | "exp"> = {
      iss: "http://seed.local",
      offerId: `off_demo_activity_${kind}`,
      customer: DEMO_ACCOUNT.customer,
      agentId: DEMO_ACCOUNT.agentId,
      productId: `prod_demo_activity_${kind}`,
      quantity: { value: 1, unit: "ST" },
      unitPrice: { net: total, vatRate: 0, currency: "EUR" },
      deposits: 0,
      total: { net: total, gross: total },
      deliveryDate: delivery,
      requestedDate: delivery,
      nextDeliveryDate: null,
      stock: "confirmed",
      paymentTerms: "invoice",
      cutoffAt: cutoff,
      replaces: null,
      shortfall: null,
      mandateId: mandate.mandateId,
      mandateVersion: mandate.version,
      constraints: { hard: [], soft: [] },
      product: {
        name: kind === "placed" ? "Demo pantry item" : "Demo bulk item",
        category: "demo",
        perSalesUnit: { value: 1, unit: "ST" },
        countryOfOrigin: null,
        deliveryReliability: null,
        co2PerKg: null,
        match: {},
      },
    };
    const token = await signOfferToken(unsigned, key, expiry);
    const result = await placeOrder(deps, DEMO_ACCOUNT, {
      idempotencyKey: `demo-activity-${kind}`,
      offers: [token],
    });
    if (!result.ok || result.value.order.status !== "pending_approval")
      throw new Error(`The demo ${kind} order could not be sent to approval.`);
    if (kind === "placed") {
      const order = result.value.order;
      const approved = await decide(deps, DEMO_ACCOUNT, order.orderId, {
        proposalVersion: order.proposalVersion,
        decision: "approve",
      });
      if (!approved.ok || approved.value.status !== "placed")
        throw new Error("The demo order could not be approved and placed.");
    }
  }
  const refused = await placeOrder(deps, DEMO_ACCOUNT, {
    idempotencyKey: "demo-activity-forged",
    offers: ["forged.demo.token"],
  });
  if (refused.ok || refused.error.code !== "OFFER_INVALID")
    throw new Error("The forged demo offer was not refused.");
};

export const seed = async (db: Db, inputs?: SeedInputs): Promise<void> => {
  if (inputs?.fetcher === undefined)
    throw new Error("The orders seed needs the in-process API fetcher.");
  const current = await mandateClient("http://seed.local/api", { fetcher: inputs.fetcher }).current(
    DEMO_ACCOUNT.agentId,
  );
  if (!current.ok || current.value === null || current.value.iss !== DEMO_ACCOUNT.customer)
    throw new Error("The orders seed needs the demo customer's current mandate.");
  await seedHistory(db, { demo: inputs.demoProducts });
  await seedActivity(db, current.value, inputs.fetcher);
};
