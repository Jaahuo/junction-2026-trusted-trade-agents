import {
  DecideApprovalRequestSchema,
  ErrorEnvelopeSchema,
  type Order,
  OrderListSchema,
  OrderRefSchema,
  OrderSchema,
  PendingListSchema,
  PlaceOrderRequestSchema,
  PrecheckRequestSchema,
  PrecheckSchema,
  RefusalListSchema,
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
import { desc, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import {
  type ApprovalDeps,
  type DecisionError,
  decide,
  listPending,
} from "../application/approvals.ts";
import { isCutoffDue, runCutoffJob } from "../application/cutoff.ts";
import { findOrder, placeOrder, precheck, type Refusal } from "../application/orders.ts";
import type { StoredOrder } from "../application/ports.ts";
import { mandateClient } from "../infra/mandate-client.ts";
import { offersClient } from "../infra/offers-client.ts";
import { processOfferVerifier } from "../infra/offer-verifier.ts";
import { postgresOrderStore, toStored } from "../infra/order-store.ts";
import { envReceiptSigner } from "../infra/receipt-signer.ts";
import { orders, refusals as refusalRows } from "../infra/schema.ts";
import { refusingPayment } from "../infra/payment/refusing-payment.ts";
import { seed } from "./seed.ts";

const principalFrom = async (request: Request): Promise<Principal> => {
  const principal = await principalOf(request.headers);
  if (!principal.ok) throw new Error("The first build always has a principal (SPEC-002).");
  return principal.value;
};

/** The approval page of a pending order, under the base URL of this read. */
const approvalUrl = (baseUrl: string, orderId: string): string =>
  `${baseUrl}/approvals/${encodeURIComponent(orderId)}`;

const toOrder = (
  { idempotencyKey: _key, requested: _requested, ...order }: StoredOrder,
  baseUrl: () => string,
): Order => ({
  ...order,
  approvalUrl: order.status === "pending_approval" ? approvalUrl(baseUrl(), order.orderId) : null,
});

export interface ApiDeps extends ApprovalDeps {
  /** Read on every response, so a new PUBLIC_BASE_URL applies to orders already stored. */
  publicBaseUrl: () => string;
  /** The account a request acts as; tests set one with its own credit limit. */
  principal: (request: Request) => Promise<Principal>;
}

const REFUSAL_STATUS = {
  BAD_REQUEST: 400,
  OFFER_INVALID: 400,
  CONFLICT: 409,
  STALE_OFFER: 409,
  UPSTREAM_FAILED: 502,
} as const satisfies Record<Refusal["code"], 400 | 409 | 502>;

const DECISION_STATUS = {
  BAD_REQUEST: 400,
  OFFER_INVALID: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_OFFER: 409,
  OFFER_EXPIRED: 409,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_FAILED: 502,
} as const satisfies Record<DecisionError["code"], 400 | 404 | 409 | 501 | 502>;

const envelope = (failure: Refusal | DecisionError) => ({
  error: { code: failure.code, message: failure.message },
});

const refused = {
  400: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  502: ErrorEnvelopeSchema,
};

const defaultDeps = (db: Db): ApiDeps => {
  let mandates: ApiDeps["mandates"] | undefined;
  return {
    store: postgresOrderStore(db),
    verifyOffer: processOfferVerifier(),
    issuedOffers: offersClient,
    // Resolved on first use: the base URL needs the server's environment.
    mandates: {
      current: (agentId) => (mandates ??= mandateClient(`${selfBaseUrl()}/api`)).current(agentId),
    },
    offers: offersClient,
    payment: refusingPayment,
    signReceipt: envReceiptSigner,
    now: () => new Date(),
    publicBaseUrl,
    principal: principalFrom,
  };
};

export const createApi = (db: Db, overrides: Partial<ApiDeps> = {}) => {
  const deps: ApiDeps = { ...defaultDeps(db), ...overrides };
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running !== undefined) return;
    running = runCutoffJob(deps)
      .catch((error: unknown) => console.error("Order cutoff job failed", error))
      .finally(() => {
        running = undefined;
      });
  };
  return new Elysia({ prefix: "/orders" })
    .onStart(() => {
      tick();
      timer = setInterval(tick, 60_000);
    })
    .onStop(async () => {
      clearInterval(timer);
      timer = undefined;
      await running;
    })
    .use(badRequestEnvelope())
    .post(
      "/",
      {
        body: PlaceOrderRequestSchema,
        response: { 200: OrderSchema, 201: OrderSchema, ...refused },
      },
      async ({ body, request, status }) => {
        const result = await placeOrder(deps, await deps.principal(request), body);
        if (!result.ok) return status(REFUSAL_STATUS[result.error.code], envelope(result.error));
        const order = toOrder(result.value.order, deps.publicBaseUrl);
        return result.value.created ? status(201, order) : order;
      },
    )
    .get("/", { response: { 200: OrderListSchema } }, async ({ request }) => {
      const principal = await deps.principal(request);
      const rows = await db
        .select()
        .from(orders)
        .where(eq(orders.customer, principal.customer))
        .orderBy(desc(orders.createdAt), desc(orders.orderId));
      return {
        orders: rows.map((row) => toOrder(toStored(row), deps.publicBaseUrl)),
      };
    })
    .get("/refusals", { response: { 200: RefusalListSchema } }, async ({ request }) => {
      const principal = await deps.principal(request);
      const rows = await db
        .select({ id: refusalRows.id, event: refusalRows.event })
        .from(refusalRows)
        .where(eq(refusalRows.customer, principal.customer))
        .orderBy(desc(sql`(${refusalRows.event} #>> '{}')::jsonb ->> 'at'`), desc(refusalRows.id));
      return {
        refusals: rows.map(({ id, event }) => {
          if (event.detail === undefined) throw new Error("Refusal event has no code.");
          return { id, at: event.at, code: event.detail };
        }),
      };
    })
    .get("/pending", { response: { 200: PendingListSchema } }, async ({ request }) => {
      const principal = await deps.principal(request);
      try {
        await runCutoffJob(deps, principal.customer);
      } catch (error) {
        console.error("Order cutoff cleanup failed before listing pending orders", error);
      }
      const now = deps.now();
      return {
        orders: (await listPending(deps, principal))
          .filter((order) => !isCutoffDue(order, now))
          .map((order) => toOrder(order, deps.publicBaseUrl)),
      };
    })
    .post(
      "/precheck",
      { body: PrecheckRequestSchema, response: { 200: PrecheckSchema, ...refused } },
      async ({ body, request, status }) => {
        const result = await precheck(deps, await deps.principal(request), body.offers);
        return result.ok
          ? result.value
          : status(REFUSAL_STATUS[result.error.code], envelope(result.error));
      },
    )
    .get(
      "/:orderId",
      { params: OrderRefSchema, response: { 200: OrderSchema, 404: ErrorEnvelopeSchema } },
      async ({ params, request, status }) => {
        const order = await findOrder(deps.store, await deps.principal(request), params.orderId);
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
          400: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          409: ErrorEnvelopeSchema,
          501: ErrorEnvelopeSchema,
          502: ErrorEnvelopeSchema,
        },
      },
      async ({ body, params, request, status }) => {
        const result = await decide(deps, await deps.principal(request), params.orderId, body);
        return result.ok
          ? toOrder(result.value, deps.publicBaseUrl)
          : status(DECISION_STATUS[result.error.code], envelope(result.error));
      },
    );
};

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "orders", api: createApi, seed };
