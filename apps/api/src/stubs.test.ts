import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEMO_ACCOUNT,
  type ErrorEnvelope,
  fixtures,
  ROUTES,
  type RouteInput,
  type RouteKey,
} from "@app/contract";
import { closeDb, contextsDir, discoverContexts, openDb } from "@app/server-kit";
import type { Api as OrdersApi } from "@ctx/orders/api";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { createApp } from "./server.ts";

// One valid input per route (SPEC-003).
const inputs: { [K in RouteKey]: RouteInput<K> } = {
  search: fixtures.searchRequest,
  offers: fixtures.offersRequest,
  place: fixtures.placeOrderRequest,
  status: { orderId: fixtures.order.orderId },
  mandate: {},
  pending: {},
  decide: { orderId: fixtures.order.orderId, ...fixtures.decideApprovalRequest },
  register: fixtures.registerMandateRequest,
  revoke: { mandateId: fixtures.storedMandate.mandate.mandateId },
  facts: fixtures.factsRequest,
  precheck: fixtures.precheckRequest,
  requote: fixtures.requoteRequest,
  validate: fixtures.validateRequest,
  account: {},
  openapi: {},
};
const implemented = new Set<RouteKey>(["search", "facts", "openapi", "offers", "requote"]);

// A context leaves this test when it adds migrations: its own route tests then cover its routes
// against a real database. The remaining stub contexts never contact the database.
const db = openDb("postgres://127.0.0.1:1/unused");
afterAll(async () => {
  await closeDb(db);
});
const isStub = (name: string): boolean => !existsSync(resolve(contextsDir, name, "migrations"));
const stubRoutes = ROUTES.filter((route) => isStub(route.context));
const routeContexts = new Set<string>(stubRoutes.map((route) => route.context));
const app = await createApp(
  db,
  (await discoverContexts()).filter((context) => routeContexts.has(context.name)),
  undefined,
);

const toRequest = (route: (typeof ROUTES)[number], input: object): Request => {
  const body: Record<string, unknown> = { ...input };
  const path = route.path.replaceAll(/:(\w+)/g, (_, name: string) => {
    const value = body[name];
    delete body[name];
    return encodeURIComponent(String(value));
  });
  return new Request(`http://localhost${path}`, {
    method: route.method,
    ...(route.method === "POST"
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
};

// Orders has migrations, so the app above leaves it out. Its decision route answers the decision
// that is not built yet (approve_and_remember) with 501 before it reads anything, so the typed
// client cases mount the orders routes alone, with no database.
const ordersContext = (await discoverContexts()).find((context) => context.name === "orders");
if (ordersContext === undefined) throw new Error("The orders context was not discovered.");
const ordersApp = new Elysia({ prefix: "/api" }).use(ordersContext.api(db));

const inProcessFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) =>
    ordersApp.handle(new Request(input, init)),
  { preconnect: fetch.preconnect },
);

test("every route of a stub context except the implemented routes answers 501 NOT_IMPLEMENTED with the error envelope, and GET /api/accounts/current returns DEMO_ACCOUNT", async () => {
  for (const route of stubRoutes) {
    if (implemented.has(route.key)) continue;
    const response = await app.handle(toRequest(route, inputs[route.key]));
    const body: unknown = await response.json();
    if (route.key === "account") {
      expect({ key: route.key, status: response.status, body }).toEqual({
        key: "account",
        status: 200,
        body: DEMO_ACCOUNT,
      });
    } else {
      expect({ key: route.key, status: response.status, body }).toEqual({
        key: route.key,
        status: 501,
        body: { error: { code: "NOT_IMPLEMENTED", message: expect.any(String) } },
      });
    }
  }
});

test("every POST route of a stub context answers 400 BAD_REQUEST with the envelope for a body field customer", async () => {
  for (const route of stubRoutes.filter((entry) => entry.method === "POST")) {
    const response = await app.handle(
      toRequest(route, { ...inputs[route.key], customer: DEMO_ACCOUNT.customer }),
    );
    expect({ key: route.key, status: response.status, body: await response.json() }).toEqual({
      key: route.key,
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: expect.stringContaining("customer") } },
    });
  }
});

test("a typed Eden client calls a not-implemented orders decision and gets the envelope typed as ErrorEnvelope", async () => {
  const orders = treaty<OrdersApi>("http://localhost/api", {
    parseDate: false,
    fetcher: inProcessFetch,
  });
  const { data, error } = await orders.orders({ orderId: fixtures.order.orderId }).decision.post({
    proposalVersion: 1,
    decision: "approve_and_remember",
    maxOrderTotal: 2000,
  });
  expect(data).toBeNull();
  if (error?.status !== 501) throw new Error(`expected 501, got ${String(error?.status)}`);
  const envelope: ErrorEnvelope = error.value;
  expect(envelope.error.code).toBe("NOT_IMPLEMENTED");
});

test("a typed Eden client handles the actual 400 validation envelope", async () => {
  const orders = treaty<OrdersApi>("http://localhost/api", {
    parseDate: false,
    fetcher: inProcessFetch,
  });
  const { error } = await orders
    .orders({ orderId: fixtures.order.orderId })
    .decision.post({ proposalVersion: 1.5, decision: "approve" });
  if (error?.status !== 400) throw new Error(`expected 400, got ${String(error?.status)}`);
  const envelope: ErrorEnvelope = error.value;
  expect(envelope.error.code).toBe("BAD_REQUEST");
});

test("an Eden client with parseDate false returns deliverBy, deliveryDate and createdAt of a fixture as the same strings", async () => {
  const echo = new Elysia().post("/echo", ({ body }) => body);
  const client = treaty<typeof echo>("http://localhost", {
    parseDate: false,
    fetcher: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => echo.handle(new Request(input, init)),
      { preconnect: fetch.preconnect },
    ),
  });
  const sent = {
    deliverBy: fixtures.searchRequest.deliverBy,
    deliveryDate: fixtures.offerClaims.deliveryDate,
    createdAt: fixtures.order.createdAt,
  };
  const { data } = await client.echo.post(sent);
  expect(data).toEqual(sent);
});
