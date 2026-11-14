import {
  DecideApprovalRequestSchema,
  ErrorEnvelopeSchema,
  OrderRefSchema,
  OrderSchema,
  PendingListSchema,
  PlaceOrderRequestSchema,
  PrecheckRequestSchema,
  PrecheckSchema,
} from "@app/contract";
import { badRequestEnvelope, type ContextModule, notImplemented } from "@app/server-kit";
import { Elysia } from "elysia";

const orderResponses = { 200: OrderSchema, 501: ErrorEnvelopeSchema };

// Typed stubs of SPEC-003; the orders issue replaces them.
export const createApi = () =>
  new Elysia({ prefix: "/orders" })
    .use(badRequestEnvelope())
    .post(
      "/",
      { body: PlaceOrderRequestSchema, response: { ...orderResponses, 201: OrderSchema } },
      ({ status }) => status(501, notImplemented("place")),
    )
    .get(
      "/pending",
      { response: { 200: PendingListSchema, 501: ErrorEnvelopeSchema } },
      ({ status }) => status(501, notImplemented("pending")),
    )
    .post(
      "/precheck",
      { body: PrecheckRequestSchema, response: { 200: PrecheckSchema, 501: ErrorEnvelopeSchema } },
      ({ status }) => status(501, notImplemented("precheck")),
    )
    .get("/:orderId", { params: OrderRefSchema, response: orderResponses }, ({ status }) =>
      status(501, notImplemented("status")),
    )
    .post(
      "/:orderId/decision",
      { params: OrderRefSchema, body: DecideApprovalRequestSchema, response: orderResponses },
      ({ status }) => status(501, notImplemented("decide")),
    );

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "orders", api: createApi };
