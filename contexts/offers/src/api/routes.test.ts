import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  AvailabilityResultSchema,
  DEMO_ACCOUNT,
  ErrorEnvelopeSchema,
  OffersResultSchema,
  type OffersRequest,
} from "@app/contract";
import type { OfferSigningKey } from "@app/contract/server";
import { err } from "@app/kernel";
import { closeDb, openDb } from "@app/server-kit";
import type { AnyElysia } from "elysia";
import {
  fakeAvailability,
  fakeOffersDeps,
  fakePrice,
  fakeProduct,
  type FakeOffers,
} from "../application/fakes.ts";
import { NO_LIVE_SOURCE_DETAIL } from "../application/get-offers.ts";
import { envOfferSigner } from "../infra/offer-signer.ts";
import { peerAdapters } from "../infra/peers.ts";
import { defaultOffersDeps } from "./adapters.ts";
import { context } from "./index.ts";
import { createApi, createRoot } from "./routes.ts";

// Invented products only (team rules R-23).
const OAT = "prod_test_oat";

const request = (patch: Record<string, unknown> = {}): OffersRequest & Record<string, unknown> => ({
  lines: [{ productId: OAT, quantity: { value: 4, unit: "CT" } }],
  deliverBy: "2026-11-20",
  paymentTerms: DEMO_ACCOUNT.paymentTerms,
  hard: [],
  soft: [],
  ...patch,
});

const offers = (): FakeOffers =>
  fakeOffersDeps({
    products: [fakeProduct(OAT)],
    live: {
      [OAT]: { availability: { "*": fakeAvailability(OAT) }, prices: { "*": fakePrice(OAT) } },
    },
  });

const postTo = (app: AnyElysia, path: string, body: object) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const post = (app: AnyElysia, body: object) => postTo(app, "/offers", body);

const errorOf = async (response: Response) => ({
  status: response.status,
  body: ErrorEnvelopeSchema.parse(await response.json()),
});

const makeKey = async (): Promise<OfferSigningKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    kid: "test-kid",
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
};

describe("POST /offers", () => {
  test("paymentTerms other than the principal's gives 400", async () => {
    const fake = offers();
    const response = await post(createApi(fake.deps), request({ paymentTerms: "pay_on_order" }));
    const { status, body } = await errorOf(response);
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(fake.live.calls).toEqual([]);
  });

  test("upstream failure gives 502", async () => {
    const failingLive = offers();
    failingLive.live.failWith(true);
    const failingCatalog = offers();
    failingCatalog.catalog.fail(true);
    for (const fake of [failingLive, failingCatalog]) {
      const { status, body } = await errorOf(await post(createApi(fake.deps), request()));
      expect(status).toBe(502);
      expect(body.error.code).toBe("UPSTREAM_FAILED");
    }
  });

  test("a body field customer gives 400", async () => {
    const fake = offers();
    const response = await post(createApi(fake.deps), request({ customer: DEMO_ACCOUNT.customer }));
    const { status, body } = await errorOf(response);
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("customer");
    expect(fake.catalog.requests).toEqual([]);
  });

  test("an unsupported hard constraint gives 400", async () => {
    const fake = offers();
    const response = await post(
      createApi(fake.deps),
      request({ hard: [{ attribute: "unicorn", is: "free_from" }] }),
    );
    const { status, body } = await errorOf(response);
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(fake.catalog.requests).toEqual([]);
  });

  test("a 200 body parses with OffersResultSchema and precheck is null when orders fails", async () => {
    const fake = offers();
    fake.orders.answerWith(err("UNAVAILABLE"));
    const response = await post(createApi(fake.deps), request());
    expect(response.status).toBe(200);
    const result = OffersResultSchema.parse(await response.json());
    expect(result.offers).toHaveLength(1);
    expect(result.offers.map((offer) => offer.precheck)).toEqual([null]);
    expect(fake.orders.calls).toHaveLength(1);
  });

  test("with no live wholesaler configured, POST /offers answers 200, omits every line NO_PRICE and signs nothing", async () => {
    const fake = offers();
    const response = await post(createApi({ ...fake.deps, live: null }), request());
    expect(response.status).toBe(200);
    expect(OffersResultSchema.parse(await response.json())).toEqual({
      offers: [],
      omitted: [{ productId: OAT, reason: "NO_PRICE", detail: NO_LIVE_SOURCE_DETAIL }],
    });
    expect(fake.signer.signed).toEqual([]);
    expect(fake.orders.calls).toEqual([]);
    expect(fake.live.calls).toEqual([]);
  });

  test("POST /offers/availability returns the products deliverable by the date, from one live read for the principal's customer", async () => {
    const LATE = "prod_test_late";
    const BLOCKED = "prod_test_blocked";
    const fake = fakeOffersDeps({
      live: {
        [OAT]: { availability: { "*": fakeAvailability(OAT) }, prices: {} },
        [LATE]: {
          availability: { "*": fakeAvailability(LATE, { availableDate: "2026-11-21" }) },
          prices: {},
        },
        [BLOCKED]: {
          availability: { "*": fakeAvailability(BLOCKED, { salesBlocked: true }) },
          prices: {},
        },
      },
    });
    const response = await postTo(createApi(fake.deps), "/offers/availability", {
      deliverBy: "2026-11-20",
      productIds: [OAT, LATE, BLOCKED, "prod_test_unknown", OAT],
    });
    expect(response.status).toBe(200);
    expect(AvailabilityResultSchema.parse(await response.json())).toEqual({ deliverable: [OAT] });
    expect(fake.live.calls).toEqual([
      {
        kind: "availability",
        query: {
          customer: DEMO_ACCOUNT.customer,
          requestedDate: "2026-11-20",
          productIds: [OAT, LATE, BLOCKED, "prod_test_unknown"],
        },
      },
    ]);
  });

  test("POST /offers/availability answers 502 when the live read fails or no live source is configured", async () => {
    const failing = offers();
    failing.live.failWith(true);
    const body = { deliverBy: "2026-11-20", productIds: [OAT] };
    for (const deps of [failing.deps, { ...offers().deps, live: null }]) {
      const { status, body: envelope } = await errorOf(
        await postTo(createApi(deps), "/offers/availability", body),
      );
      expect(status).toBe(502);
      expect(envelope.error.code).toBe("UPSTREAM_FAILED");
    }
  });

  test("validate still answers 501 NOT_IMPLEMENTED", async () => {
    const app = createApi(offers().deps);
    for (const path of ["validate"]) {
      const response = await app.handle(
        new Request(`http://localhost/offers/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tokens: ["a.b.c"] }),
        }),
      );
      const { status, body } = await errorOf(response);
      expect({ path, status, code: body.error.code }).toEqual({
        path,
        status: 501,
        code: "NOT_IMPLEMENTED",
      });
    }
  });
});

test("GET /.well-known/jwks.json returns the public key only", async () => {
  const key = await makeKey();
  const deps = { ...offers().deps, signer: envOfferSigner(async () => key) };
  const response = await createRoot(deps).handle(
    new Request("http://localhost/.well-known/jwks.json"),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toEqual({
    keys: [
      {
        kty: "EC",
        crv: "P-256",
        x: key.publicJwk.x,
        y: key.publicJwk.y,
        kid: "test-kid",
        alg: "ES256",
        use: "sig",
      },
    ],
  });
});

describe("context wiring", () => {
  const db = openDb("postgres://127.0.0.1:1/unused");
  afterAll(async () => {
    await closeDb(db);
  });

  test("building context.api and context.root does not throw and calls no peer", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      expect(context.root).toBeDefined();
      expect(() => context.api(db)).not.toThrow();
      expect(() => context.root?.(db)).not.toThrow();
      await Bun.sleep(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("with the default adapters and no reachable peers, POST /offers answers 502 with the error envelope", async () => {
    // Only the peer base URL is injected, so the test does not depend on PORT or a running server.
    const unreachable = peerAdapters({ baseUrl: () => "http://127.0.0.1:1" });
    // A fake live source keeps the case independent of WHOLESALER_LIVE in the environment.
    const app = createApi({ ...defaultOffersDeps(), ...unreachable, live: offers().deps.live });
    const response = await post(app, request());
    const { status, body } = await errorOf(response);
    expect({ status, code: body.error.code }).toEqual({ status: 502, code: "UPSTREAM_FAILED" });
  });
});
