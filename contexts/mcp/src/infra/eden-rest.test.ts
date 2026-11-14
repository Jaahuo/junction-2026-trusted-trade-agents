import { expect, test } from "bun:test";
import { fixtures } from "@app/contract";
import { err, ok } from "@app/kernel";
import { edenTradeRest } from "./eden-rest.ts";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const fakeFetch = (answer: () => Response | Promise<Response>) => {
  const sent: Sent[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.text();
      sent.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text === "" ? undefined : JSON.parse(text),
      });
      return answer();
    },
    { preconnect: fetch.preconnect },
  );
  return { rest: edenTradeRest(() => "http://peer.test", fetcher), sent };
};

test("status puts orderId in the path of GET /api/orders/:orderId", async () => {
  const { rest, sent } = fakeFetch(() => Response.json(fixtures.order));
  expect(await rest.status("ord_42")).toEqual(ok(fixtures.order));
  expect(sent).toEqual([{ method: "GET", path: "/api/orders/ord_42", body: undefined }]);
});

test("decide puts orderId in the path and the decision fields in the body", async () => {
  const { rest, sent } = fakeFetch(() => Response.json(fixtures.order));
  expect(await rest.decide("ord_42", fixtures.decideApprovalRequest)).toEqual(ok(fixtures.order));
  expect(sent).toEqual([
    { method: "POST", path: "/api/orders/ord_42/decision", body: fixtures.decideApprovalRequest },
  ]);
});

test("search posts the input as the body and returns the REST body", async () => {
  const { rest, sent } = fakeFetch(() => Response.json(fixtures.searchResult));
  expect(await rest.search(fixtures.searchRequest)).toEqual(ok(fixtures.searchResult));
  expect(sent).toEqual([
    { method: "POST", path: "/api/catalog/search", body: fixtures.searchRequest },
  ]);
});

test("draft posts the input to /api/mandates/drafts and returns the draft", async () => {
  const { rest, sent } = fakeFetch(() => Response.json(fixtures.mandateDraft));
  expect(await rest.draft(fixtures.draftMandateRequest)).toEqual(ok(fixtures.mandateDraft));
  expect(sent).toEqual([
    { method: "POST", path: "/api/mandates/drafts", body: fixtures.draftMandateRequest },
  ]);
});

test("revoke puts mandateId in the path", async () => {
  const { rest, sent } = fakeFetch(() => Response.json(fixtures.storedMandate));
  await rest.revoke("mnd_7");
  expect(sent.map(({ method, path }) => ({ method, path }))).toEqual([
    { method: "POST", path: "/api/mandates/mnd_7/revoke" },
  ]);
});

test("an error envelope from the route is returned as the error", async () => {
  const { rest } = fakeFetch(() => Response.json(fixtures.errorEnvelope, { status: 409 }));
  expect(await rest.place(fixtures.placeOrderRequest)).toEqual(err(fixtures.errorEnvelope));
});

test("an error without an envelope gives UPSTREAM_FAILED", async () => {
  const { rest } = fakeFetch(() => new Response("bad gateway", { status: 502 }));
  expect(await rest.pending()).toEqual(
    err({ error: { code: "UPSTREAM_FAILED", message: expect.stringContaining("502") } }),
  );
});

test("a 2xx body that does not match the route schema gives UPSTREAM_FAILED", async () => {
  const { rest } = fakeFetch(() => Response.json({ orders: "none" }));
  expect(await rest.pending()).toEqual(
    err({ error: { code: "UPSTREAM_FAILED", message: expect.stringContaining("schema") } }),
  );
});

test("an unreachable peer gives UPSTREAM_FAILED", async () => {
  const { rest } = fakeFetch(() => {
    throw new TypeError("connection refused");
  });
  expect(await rest.mandate()).toEqual(
    err({ error: { code: "UPSTREAM_FAILED", message: expect.any(String) } }),
  );
});

test("a response with malformed JSON gives UPSTREAM_FAILED", async () => {
  const { rest } = fakeFetch(
    () => new Response("{", { status: 502, headers: { "content-type": "application/json" } }),
  );
  expect(await rest.place(fixtures.placeOrderRequest)).toEqual(
    err({ error: { code: "UPSTREAM_FAILED", message: expect.any(String) } }),
  );
});

test("a 2xx response with malformed JSON gives UPSTREAM_FAILED", async () => {
  const { rest } = fakeFetch(
    () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
  );
  expect(await rest.status("ord_42")).toEqual(
    err({ error: { code: "UPSTREAM_FAILED", message: expect.any(String) } }),
  );
});
