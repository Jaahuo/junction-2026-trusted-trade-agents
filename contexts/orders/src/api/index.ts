import {
  DecideApprovalRequestSchema,
  ErrorEnvelopeSchema,
  type Order,
  OrderRefSchema,
  OrderSchema,
  PendingListSchema,
  PlaceOrderRequestSchema,
  PrecheckRequestSchema,
  PrecheckSchema,
  type Principal,
} from "@app/contract";
import { principalOf } from "@app/contract/server";
import {
  badRequestEnvelope,
  type ContextModule,
  type Db,
  publicBaseUrl,
  selfBaseUrl,
} from "@app/server-kit";
import { Elysia } from "elysia";
import { type DecisionError, decide, listPending } from "../application/approvals.ts";
import {
  findOrder,
  type OrderDeps,
  placeOrder,
  precheck,
  type Refusal,
} from "../application/orders.ts";
import type { StoredOrder } from "../application/ports.ts";
import { mandateClient } from "../infra/mandate-client.ts";
import { processOfferVerifier } from "../infra/offer-verifier.ts";
import { postgresOrderStore } from "../infra/order-store.ts";
import { envReceiptSigner } from "../infra/receipt-signer.ts";
import { refusingPayment } from "../infra/payment/refusing-payment.ts";
import { seed } from "./seed.ts";

const principalFrom = async (request: Request): Promise<Principal> => {
  const principal = await principalOf(request.headers);
  if (!principal.ok) throw new Error("The first build always has a principal (SPEC-002).");
  return principal.value;
};

/** The approval page of a pending order, under the base URL of this read. */
const approvalUrl = (baseUrl: string, orderId: string): string =>
  `${baseUrl}/approvals?order=${encodeURIComponent(orderId)}`;

const toOrder = (
  { idempotencyKey: _key, requested: _requested, ...order }: StoredOrder,
  baseUrl: () => string,
): Order => ({
  ...order,
  approvalUrl: order.status === "pending_approval" ? approvalUrl(baseUrl(), order.orderId) : null,
});

export interface ApiDeps extends OrderDeps {
  /** Read on every response, so a new PUBLIC_BASE_URL applies to orders already stored. */
  publicBaseUrl: () => string;
}

const REFUSAL_STATUS = {
  BAD_REQUEST: 400,
  OFFER_INVALID: 400,
  CONFLICT: 409,
  STALE_OFFER: 409,
  UPSTREAM_FAILED: 502,
} as const satisfies Record<Refusal["code"], 400 | 409 | 502>;

const DECISION_STATUS = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_OFFER: 409,
  OFFER_EXPIRED: 409,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_FAILED: 502,
} as const satisfies Record<DecisionError["code"], 404 | 409 | 501 | 502>;

const envelope = (failure: Refusal | DecisionError) => ({
  error: { code: failure.code, message: failure.message },
});

const refused = {
  400: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  502: ErrorEnvelopeSchema,
};

const defaultDeps = (db: Db): ApiDeps => {
  let mandates: OrderDeps["mandates"] | undefined;
  return {
    store: postgresOrderStore(db),
    verifyOffer: processOfferVerifier(),
    // Resolved on first use: the base URL needs the server's environment.
    mandates: {
      current: (agentId) => (mandates ??= mandateClient(`${selfBaseUrl()}/api`)).current(agentId),
    },
    payment: refusingPayment,
    signReceipt: envReceiptSigner,
    now: () => new Date(),
    publicBaseUrl,
  };
};

export const createApi = (db: Db, overrides: Partial<ApiDeps> = {}) => {
  const deps: ApiDeps = { ...defaultDeps(db), ...overrides };
  return new Elysia({ prefix: "/orders" })
    .use(badRequestEnvelope())
    .post(
      "/",
      {
        body: PlaceOrderRequestSchema,
        response: { 200: OrderSchema, 201: OrderSchema, ...refused },
      },
      async ({ body, request, status }) => {
        const result = await placeOrder(deps, await principalFrom(request), body);
        if (!result.ok) return status(REFUSAL_STATUS[result.error.code], envelope(result.error));
        const order = toOrder(result.value.order, deps.publicBaseUrl);
        return result.value.created ? status(201, order) : order;
      },
    )
    .get("/pending", { response: { 200: PendingListSchema } }, async ({ request }) => ({
      orders: (await listPending(deps, await principalFrom(request))).map((order) =>
        toOrder(order, deps.publicBaseUrl),
      ),
    }))
    .post(
      "/precheck",
      { body: PrecheckRequestSchema, response: { 200: PrecheckSchema, ...refused } },
      async ({ body, request, status }) => {
        const result = await precheck(deps, await principalFrom(request), body.offers);
        return result.ok
          ? result.value
          : status(REFUSAL_STATUS[result.error.code], envelope(result.error));
      },
    )
    .get(
      "/:orderId",
      { params: OrderRefSchema, response: { 200: OrderSchema, 404: ErrorEnvelopeSchema } },
      async ({ params, request, status }) => {
        const order = await findOrder(deps.store, await principalFrom(request), params.orderId);
        return order === null
          ? status(404, { error: { code: "NOT_FOUND" as const, message: "No such order." } })
          : toOrder(order, deps.publicBaseUrl);
      },
    )
    .post(
      "/:orderId/decision",
      {
        params: OrderRefSchema,
        body: DecideApprovalRequestSchema,
        response: {
          200: OrderSchema,
          404: ErrorEnvelopeSchema,
          409: ErrorEnvelopeSchema,
          501: ErrorEnvelopeSchema,
          502: ErrorEnvelopeSchema,
        },
      },
      async ({ body, params, request, status }) => {
        const result = await decide(deps, await principalFrom(request), params.orderId, body);
        return result.ok
          ? toOrder(result.value, deps.publicBaseUrl)
          : status(DECISION_STATUS[result.error.code], envelope(result.error));
      },
    );
};

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "orders", api: createApi, seed };
