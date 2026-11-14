import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { err, ok } from "@app/kernel";
import { fixtures } from "../index.ts";
import { callRoute } from "./call-route.ts";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let answer: () => Response = () => Response.json({});
const sent: Sent[] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const text = await request.text();
    sent.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text === "" ? undefined : JSON.parse(text),
    });
    return answer();
  },
});

const savedBaseUrl = process.env["INTERNAL_BASE_URL"];
beforeAll(() => {
  process.env["INTERNAL_BASE_URL"] = server.url.origin;
});
afterEach(() => {
  sent.length = 0;
});
afterAll(async () => {
  if (savedBaseUrl === undefined) delete process.env["INTERNAL_BASE_URL"];
  else process.env["INTERNAL_BASE_URL"] = savedBaseUrl;
  await server.stop(true);
});

test("callRoute returns UPSTREAM_FAILED on a non-2xx response and validates the body", async () => {
  // A body that would pass the output schema, so only the status check can refuse it.
  answer = () => Response.json(fixtures.precheck, { status: 502 });
  expect(await callRoute("precheck", fixtures.precheckRequest)).toEqual(err("UPSTREAM_FAILED"));

  answer = () => new Response("<html>bad gateway</html>", { status: 200 });
  expect(await callRoute("precheck", fixtures.precheckRequest)).toEqual(err("UPSTREAM_FAILED"));

  answer = () => Response.json({ decision: "maybe", reasons: [] });
  expect(await callRoute("precheck", fixtures.precheckRequest)).toEqual(err("UPSTREAM_FAILED"));

  answer = () => Response.json(fixtures.precheck);
  expect(await callRoute("precheck", fixtures.precheckRequest)).toEqual(ok(fixtures.precheck));
  expect(sent.at(-1)).toEqual({
    method: "POST",
    path: "/api/orders/precheck",
    body: fixtures.precheckRequest,
  });
});

test("callRoute returns the code of an error envelope", async () => {
  answer = () => Response.json(fixtures.errorEnvelope, { status: 409 });
  expect(await callRoute("place", fixtures.placeOrderRequest)).toEqual(err("STALE_OFFER"));

  answer = () =>
    Response.json({ error: { code: "NOT_IMPLEMENTED", message: "stub" } }, { status: 501 });
  expect(await callRoute("precheck", fixtures.precheckRequest)).toEqual(err("NOT_IMPLEMENTED"));
});

test("callRoute puts path parameters in the path and the rest in the body", async () => {
  answer = () => Response.json(fixtures.order);
  expect(await callRoute("status", { orderId: "ord 42" })).toEqual(ok(fixtures.order));
  expect(
    await callRoute("decide", { orderId: "ord_42", ...fixtures.decideApprovalRequest }),
  ).toEqual(ok(fixtures.order));
  expect(sent).toEqual([
    { method: "GET", path: "/api/orders/ord%2042", body: undefined },
    { method: "POST", path: "/api/orders/ord_42/decision", body: fixtures.decideApprovalRequest },
  ]);
});

test("callRoute refuses an input that fails the route schema with BAD_REQUEST and sends nothing", async () => {
  const withCustomer = { ...fixtures.precheckRequest, customer: "cust_other" };
  expect(await callRoute("precheck", withCustomer)).toEqual(err("BAD_REQUEST"));
  expect(sent).toEqual([]);
});

test("callRoute returns UPSTREAM_FAILED when the peer is unreachable", async () => {
  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = closed.url.origin;
  await closed.stop(true);
  process.env["INTERNAL_BASE_URL"] = url;
  try {
    expect(await callRoute("precheck", fixtures.precheckRequest)).toEqual(err("UPSTREAM_FAILED"));
  } finally {
    process.env["INTERNAL_BASE_URL"] = server.url.origin;
  }
});

test("callRoute throws on a missing base URL instead of reporting an upstream failure", async () => {
  const savedPort = process.env["PORT"];
  delete process.env["INTERNAL_BASE_URL"];
  delete process.env["PORT"];
  try {
    const outcome = await callRoute("precheck", fixtures.precheckRequest).then(
      (result) => result,
      (error: unknown) => String(error),
    );
    expect(outcome).toBe("Error: Set PORT or INTERNAL_BASE_URL.");
    expect(sent).toEqual([]);
  } finally {
    process.env["INTERNAL_BASE_URL"] = server.url.origin;
    if (savedPort !== undefined) process.env["PORT"] = savedPort;
  }
});
