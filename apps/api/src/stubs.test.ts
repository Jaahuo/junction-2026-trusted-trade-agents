import { afterAll, expect, test } from "bun:test";
import {
  DEMO_ACCOUNT,
  type ErrorEnvelope,
  fixtures,
  ROUTES,
  type RouteInput,
  type RouteKey,
} from "@app/contract";
import { closeDb, discoverContexts, openDb } from "@app/server-kit";
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

// The stub contexts have no migrations, so the database is never contacted.
const db = openDb("postgres://127.0.0.1:1/unused");
afterAll(async () => {
  await closeDb(db);
});
const routeContexts = new Set<string>(ROUTES.map((route) => route.context));
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

const inProcessFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => app.handle(new Request(input, init)),
  { preconnect: fetch.preconnect },
);

test("every ROUTES entry answers 501 NOT_IMPLEMENTED with the error envelope, except GET /api/accounts/current, which returns DEMO_ACCOUNT", async () => {
  for (const route of ROUTES) {
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

test("every POST route answers 400 BAD_REQUEST with the envelope for a body field customer", async () => {
  for (const route of ROUTES.filter((entry) => entry.method === "POST")) {
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

test("a typed Eden client from offers calls the orders precheck stub and gets the envelope typed as ErrorEnvelope", async () => {
  const orders = treaty<OrdersApi>("http://localhost/api", {
    parseDate: false,
    fetcher: inProcessFetch,
  });
  const { data, error } = await orders.orders.precheck.post(fixtures.precheckRequest);
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
  const { error } = await orders.orders.precheck.post({ offers: [] });
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
