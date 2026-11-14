import { describe, expect, test } from "bun:test";
import { fixtures } from "@app/contract";
import { PRECHECK_TIMEOUT_MS, peerAdapters } from "./peers.ts";

const BASE = "http://peers.test";
const envelope = (code: string) => ({ error: { code, message: code } });

type Handler = (request: Request) => Response | Promise<Response>;

const withPreconnect = <F extends (...args: never[]) => unknown>(fn: F) =>
  Object.assign(fn, { preconnect: fetch.preconnect });

// Stands in for a peer app: answers only the one route, 404 elsewhere.
const route = (method: string, path: string, handler: Handler) =>
  withPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (request.method === method && pathname === path) return handler(request);
    return Response.json(envelope("NOT_FOUND"), { status: 404 });
  });

const reply =
  (status: number, body: unknown): Handler =>
  () =>
    Response.json(body, { status });

const failingFetcher = withPreconnect(async (): Promise<Response> => {
  throw new Error("connection refused");
});

const neverFetcher = withPreconnect(() => new Promise<Response>(() => undefined));

const throwingBase = (): string => {
  throw new Error("Set PORT or INTERNAL_BASE_URL.");
};

const peers = (fetcher: typeof fetch) => peerAdapters({ fetcher, baseUrl: () => BASE });

const precheckApp = (status: number, body: unknown) =>
  route("POST", "/api/orders/precheck", reply(status, body));
const mandateApp = (status: number, body: unknown) =>
  route("GET", "/api/mandates/current", reply(status, body));
const factsApp = (status: number, body: unknown) =>
  route("POST", "/api/catalog/facts", reply(status, body));

describe("orders precheck", () => {
  test("precheck is null when orders answers 501 or is unreachable", async () => {
    const token = "tok";
    const notImplemented = await peers(
      precheckApp(501, envelope("NOT_IMPLEMENTED")),
    ).orders.precheck(token);
    expect(notImplemented).toEqual({ ok: false, error: "UNAVAILABLE" });
    const unreachable = await peerAdapters({
      fetcher: failingFetcher,
      baseUrl: () => BASE,
    }).orders.precheck(token);
    expect(unreachable).toEqual({ ok: false, error: "UNAVAILABLE" });
    const noBase = await peerAdapters({
      fetcher: failingFetcher,
      baseUrl: throwingBase,
    }).orders.precheck(token);
    expect(noBase).toEqual({ ok: false, error: "UNAVAILABLE" });
    const answered = await peers(precheckApp(200, fixtures.precheck)).orders.precheck(token);
    expect(answered).toEqual({ ok: true, value: fixtures.precheck });
  });

  test("the precheck sends the token in the offers array", async () => {
    let received: unknown;
    const app = route("POST", "/api/orders/precheck", async (request) => {
      received = await request.json();
      return Response.json(fixtures.precheck);
    });
    await peers(app).orders.precheck("tok_1");
    expect(received).toEqual({ offers: ["tok_1"] });
  });

  test("a precheck that never answers gives UNAVAILABLE after the deadline", async () => {
    const started = performance.now();
    const signals: (AbortSignal | null | undefined)[] = [];
    const recording = withPreconnect((input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? (input instanceof Request ? input.signal : undefined));
      return neverFetcher();
    });
    const result = await peerAdapters({
      fetcher: recording,
      baseUrl: () => BASE,
      precheckTimeoutMs: 20,
    }).orders.precheck("tok");
    expect(result).toEqual({ ok: false, error: "UNAVAILABLE" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("the default precheck deadline is 2000 ms", () => {
    expect(PRECHECK_TIMEOUT_MS).toBe(2000);
  });
});

describe("current mandate", () => {
  test("mandate 404 or 501 gives no mandate; 5xx, unreachable or a throwing base-URL resolver gives UPSTREAM_FAILED", async () => {
    expect(await peers(mandateApp(404, envelope("NOT_FOUND"))).mandates.current()).toEqual({
      ok: true,
      value: null,
    });
    expect(await peers(mandateApp(501, envelope("NOT_IMPLEMENTED"))).mandates.current()).toEqual({
      ok: true,
      value: null,
    });
    expect(await peers(mandateApp(500, envelope("INTERNAL"))).mandates.current()).toEqual({
      ok: false,
      error: "UPSTREAM_FAILED",
    });
    expect(
      await peerAdapters({ fetcher: failingFetcher, baseUrl: () => BASE }).mandates.current(),
    ).toEqual({ ok: false, error: "UPSTREAM_FAILED" });
    expect(
      await peerAdapters({ fetcher: failingFetcher, baseUrl: throwingBase }).mandates.current(),
    ).toEqual({
      ok: false,
      error: "UPSTREAM_FAILED",
    });
  });

  test("a plain-text 404 from mandates gives UPSTREAM_FAILED", async () => {
    const plain = route(
      "GET",
      "/api/mandates/current",
      () => new Response("Not Found", { status: 404 }),
    );
    expect(await peers(plain).mandates.current()).toEqual({ ok: false, error: "UPSTREAM_FAILED" });
    expect(await peers(mandateApp(404, envelope("BAD_REQUEST"))).mandates.current()).toEqual({
      ok: false,
      error: "UPSTREAM_FAILED",
    });
    expect(await peers(failingFetcher).mandates.current()).toEqual({
      ok: false,
      error: "UPSTREAM_FAILED",
    });
  });

  test("mandate 200 returns the mandate of the stored mandate", async () => {
    const result = await peers(mandateApp(200, fixtures.storedMandate)).mandates.current();
    expect(result).toEqual({ ok: true, value: fixtures.storedMandate.mandate });
  });
});

describe("catalog facts", () => {
  test("facts 200 returns the facts; non-2xx, unreachable or a throwing base-URL resolver gives UPSTREAM_FAILED", async () => {
    let received: unknown;
    const app = route("POST", "/api/catalog/facts", async (request) => {
      received = await request.json();
      return Response.json(fixtures.factsResult);
    });
    expect(await peers(app).catalog.facts(fixtures.factsRequest)).toEqual({
      ok: true,
      value: fixtures.factsResult,
    });
    expect(received).toEqual(fixtures.factsRequest);
    for (const status of [400, 501, 502]) {
      expect(
        await peers(factsApp(status, envelope("UPSTREAM_FAILED"))).catalog.facts(
          fixtures.factsRequest,
        ),
      ).toEqual({
        ok: false,
        error: "UPSTREAM_FAILED",
      });
    }
    expect(
      await peerAdapters({ fetcher: failingFetcher, baseUrl: () => BASE }).catalog.facts(
        fixtures.factsRequest,
      ),
    ).toEqual({ ok: false, error: "UPSTREAM_FAILED" });
    expect(
      await peerAdapters({ fetcher: failingFetcher, baseUrl: throwingBase }).catalog.facts(
        fixtures.factsRequest,
      ),
    ).toEqual({ ok: false, error: "UPSTREAM_FAILED" });
  });
});

describe("contract", () => {
  test("a 200 body that fails the contract schema is a failure", async () => {
    const bad = { unexpected: true };
    expect(await peers(factsApp(200, bad)).catalog.facts(fixtures.factsRequest)).toEqual({
      ok: false,
      error: "UPSTREAM_FAILED",
    });
    expect(await peers(mandateApp(200, bad)).mandates.current()).toEqual({
      ok: false,
      error: "UPSTREAM_FAILED",
    });
    expect(await peers(precheckApp(200, bad)).orders.precheck("tok")).toEqual({
      ok: false,
      error: "UNAVAILABLE",
    });
  });

  test("building the adapters does not call the base-URL resolver; each call does", async () => {
    let calls = 0;
    const adapters = peerAdapters({
      fetcher: failingFetcher,
      baseUrl: () => {
        calls += 1;
        return BASE;
      },
    });
    expect(calls).toBe(0);
    await adapters.catalog.facts(fixtures.factsRequest);
    await adapters.mandates.current();
    await adapters.orders.precheck("tok");
    expect(calls).toBe(3);
  });

  test("the base URL gets the /api prefix", async () => {
    const urls: string[] = [];
    const inner = mandateApp(200, fixtures.storedMandate);
    const spy = withPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(new Request(input, init).url);
      return inner(input, init);
    });
    const result = await peers(spy).mandates.current();
    expect(urls).toEqual([`${BASE}/api/mandates/current`]);
    expect(result.ok).toBe(true);
  });
});
