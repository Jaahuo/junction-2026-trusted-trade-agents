import { describe, expect, test } from "bun:test";
import {
  AvailabilityQuoteSchema,
  type LiveQuery,
  PriceQuoteSchema,
  type WholesalerLive,
} from "@app/contract";
import { mockWholesaler, mockWholesalerFromEnv } from "./wholesaler-mock.ts";

interface Call {
  path: string;
  headers: Headers;
  body: { customer: string; requestedDate: string; products: string[] };
}

type Responder = (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const harness = (
  responder: Responder,
  options: { now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
) => {
  const calls: Call[] = [];
  const fetchStub = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const call: Call = {
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      };
      calls.push(call);
      return responder(call);
    },
    { preconnect: fetch.preconnect },
  );
  const live = mockWholesaler({
    baseUrl: "https://wholesaler.test/",
    apiKey: "test-key",
    fetch: fetchStub,
    ...options,
  });
  return { live, calls };
};

const fakeClock = (initial = Date.parse("2026-11-14T10:00:00Z")) => {
  let time = initial;
  const waits: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number, _signal: AbortSignal) => {
      waits.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    waits,
  };
};

const query = (productIds: string[], requestedDate = "2026-11-16"): LiveQuery => ({
  customer: "cust_test",
  requestedDate,
  productIds,
});

const line = (availableDate: string | null, availableAmount = 10, salesBlock = false) => ({
  salesBlock,
  availableAmount,
  availableDate,
  salesUnit: "ST",
});

const product = (
  productId: string,
  scheduleLines: ReturnType<typeof line>[],
  extra: { closingTime?: string | null; salesBlock?: boolean; logisticModel?: string | null } = {},
) => ({
  productId,
  closingTime: extra.closingTime ?? null,
  salesBlock: extra.salesBlock ?? false,
  logisticModel: extra.logisticModel === undefined ? "Stock" : extra.logisticModel,
  scheduleLines,
});

const availabilityBody = (products: unknown[]) => ({
  timeNow: "2026-11-14T10:00:00",
  requestedDate: "2026-11-16T00:00:00",
  products,
});

const priceItem = (productId: string, over: Record<string, unknown> = {}) => ({
  productId,
  quantity: 1,
  catalogPrice: {
    value: 14.4,
    valueWithTax: 16.42,
    validFrom: "2026-11-01",
    validTo: "2026-11-30T23:59:59+02:00",
    currency: "EUR",
  },
  priceWithTax: null,
  comparisonPrice: null,
  comparisonUnit: null,
  tax: { taxRate: 14, taxValue: 2.02 },
  listPrice: null,
  netPriceFound: true,
  error: false,
  ...over,
});

const priceBody = (products: unknown[]) => ({
  customerId: "cust_test",
  currency: "EUR",
  pricingDate: "2026-11-16",
  products,
});

const availabilityOf = async (live: WholesalerLive, q: LiveQuery) => {
  const result = await live.getAvailability(q);
  if (!result.ok) throw new Error("expected ok availability");
  for (const quote of result.value.quotes) AvailabilityQuoteSchema.parse(quote);
  return result.value;
};

const pricesOf = async (live: WholesalerLive, q: LiveQuery) => {
  const result = await live.getPrices(q);
  if (!result.ok) throw new Error("expected ok prices");
  for (const quote of result.value.quotes) PriceQuoteSchema.parse(quote);
  return result.value;
};

describe("availability mapping", () => {
  test("the mock adapter maps the documented response: availableDate from the first open schedule line, nextDeliveryDate from a later line, else from one further query, else null", async () => {
    const { live, calls } = harness(({ body }) => {
      if (body.requestedDate === "2026-11-18") {
        return json(
          availabilityBody([
            product("p-single", [line("2026-11-18T00:00:00")]),
            product("p-empty-further", []),
          ]),
        );
      }
      return json(
        availabilityBody([
          product("p-multi", [
            line("2026-11-15T00:00:00", 5, true),
            line("2026-11-16T00:00:00", 0),
            line("2026-11-17T00:00:00", 7),
            line("2026-11-19T00:00:00", 9),
          ]),
          product("p-single", [line("2026-11-17T00:00:00", 4)]),
          product("p-empty-further", [line("2026-11-17T00:00:00", 3)]),
          product("p-nothing", []),
        ]),
      );
    });
    const value = await availabilityOf(
      live,
      query(["p-multi", "p-single", "p-empty-further", "p-nothing", "p-absent"]),
    );
    const byId = new Map(value.quotes.map((quote) => [quote.productId, quote]));
    expect(byId.get("p-multi")).toMatchObject({
      availableDate: "2026-11-17",
      amount: 7,
      nextDeliveryDate: "2026-11-19",
      salesBlocked: false,
      stock: "confirmed",
    });
    expect(byId.get("p-single")).toMatchObject({
      availableDate: "2026-11-17",
      amount: 4,
      nextDeliveryDate: "2026-11-18",
    });
    expect(byId.get("p-empty-further")).toMatchObject({
      availableDate: "2026-11-17",
      nextDeliveryDate: null,
    });
    expect(byId.get("p-nothing")).toMatchObject({
      availableDate: null,
      amount: 0,
      nextDeliveryDate: null,
      salesBlocked: false,
    });
    expect(value.missing).toEqual(["p-absent"]);
    const further = calls.filter((call) => call.body.requestedDate === "2026-11-18");
    expect(further).toHaveLength(1);
    expect(further[0]?.body.products.toSorted()).toEqual(["p-empty-further", "p-single"]);
  });

  // Shaped from a recorded live response of 2026-11-14 for a supplier-warehouse product; the id is invented.
  test("the recorded live supplier-warehouse amount maps to unconfirmed", async () => {
    const { live } = harness(() =>
      json({
        timeNow: "2026-11-14T16:51:47+0200",
        requestedDate: "2026-11-16T00:00:00+0200",
        products: [
          {
            productId: "p-terminal",
            closingTime: "2026-11-15T14:00:00+0200",
            salesBlock: false,
            logisticModel: "Terminal",
            scheduleLines: [
              {
                salesBlock: false,
                availableAmount: 999999,
                availableDate: "2026-11-16",
                salesUnit: "ST",
              },
            ],
          },
        ],
      }),
    );
    const value = await availabilityOf(live, query(["p-terminal"]));
    expect(value.quotes[0]).toMatchObject({ amount: 999999, stock: "unconfirmed" });
  });

  test("a Stock product is confirmed at any amount, including the large amounts of plentiful stock", async () => {
    const amounts = [10, 999999, 1999999999, 9999999999];
    const { live } = harness(({ body }) =>
      json(
        availabilityBody(
          body.requestedDate === "2026-11-16"
            ? amounts.map((amount) => product(`p-${amount}`, [line("2026-11-16", amount)]))
            : [],
        ),
      ),
    );
    const value = await availabilityOf(live, query(amounts.map((amount) => `p-${amount}`)));
    expect(value.quotes.map((quote) => quote.stock)).toEqual(amounts.map(() => "confirmed"));
  });

  test("999999 with no logisticModel gives stock unconfirmed", async () => {
    const { live } = harness(({ body }) =>
      json(
        availabilityBody(
          body.requestedDate === "2026-11-16"
            ? [
                product("p-unknown", [line("2026-11-16", 999999)], { logisticModel: null }),
                product("p-other", [line("2026-11-16", 999998)], { logisticModel: null }),
              ]
            : [],
        ),
      ),
    );
    const value = await availabilityOf(live, query(["p-unknown", "p-other"]));
    const byId = new Map(value.quotes.map((quote) => [quote.productId, quote.stock]));
    expect(Object.fromEntries(byId)).toEqual({
      "p-unknown": "unconfirmed",
      "p-other": "confirmed",
    });
  });

  test("the further query runs at most once per product per call", async () => {
    const { live, calls } = harness(({ body }) => {
      if (body.requestedDate === "2026-11-18") {
        return json(availabilityBody([product("p-a", [line("2026-11-20T00:00:00")])]));
      }
      return json(
        availabilityBody([
          product("p-a", [line("2026-11-17T00:00:00")]),
          product("p-b", [line("2026-11-17T00:00:00"), line("2026-11-21T00:00:00")]),
        ]),
      );
    });
    const value = await availabilityOf(live, query(["p-a", "p-b"]));
    expect(value.quotes.find((quote) => quote.productId === "p-a")?.nextDeliveryDate).toBe(
      "2026-11-20",
    );
    const queried = calls.flatMap((call) => call.body.products);
    expect(queried.filter((id) => id === "p-a")).toHaveLength(2);
    expect(queried.filter((id) => id === "p-b")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("a datetime availableDate becomes YYYY-MM-DD and an offsetless closingTime is read as Europe/Helsinki time", async () => {
    const { live } = harness(({ body }) =>
      json(
        availabilityBody(
          body.requestedDate === "2026-11-16"
            ? [
                product("p-winter", [line("2026-11-16T00:00:00")], {
                  closingTime: "2026-11-15T08:30:00",
                }),
                product("p-summer", [line("2026-07-16T00:00:00")], {
                  closingTime: "2026-07-15T08:30:00",
                }),
                product("p-offset", [line("2026-11-16")], {
                  closingTime: "2026-11-15T08:30:00+01:00",
                }),
              ]
            : [],
        ),
      ),
    );
    const value = await availabilityOf(live, query(["p-winter", "p-summer", "p-offset"]));
    const byId = new Map(value.quotes.map((quote) => [quote.productId, quote]));
    expect(byId.get("p-winter")).toMatchObject({
      availableDate: "2026-11-16",
      cutoffAt: "2026-11-15T08:30:00+02:00",
    });
    expect(byId.get("p-summer")?.cutoffAt).toBe("2026-07-15T08:30:00+03:00");
    expect(byId.get("p-offset")?.cutoffAt).toBe("2026-11-15T08:30:00+01:00");
    expect(Date.parse(byId.get("p-winter")?.cutoffAt ?? "")).toBe(
      Date.parse("2026-11-15T06:30:00Z"),
    );
  });
});

describe("price mapping", () => {
  test("price maps net, vatRate and validTo; an error price is missing", async () => {
    const { live } = harness(() =>
      json(
        priceBody([
          priceItem("p-ok"),
          priceItem("p-error", { error: true, catalogPrice: null, tax: null }),
        ]),
      ),
    );
    const value = await pricesOf(live, query(["p-ok", "p-error", "p-absent"]));
    expect(value.quotes).toEqual([
      {
        productId: "p-ok",
        unitPrice: { net: 14.4, vatRate: 14, currency: "EUR" },
        deposit: 0,
        depositKnown: false,
        comparisonPrice: null,
        validTo: "2026-11-30T23:59:59+02:00",
      },
    ]);
    expect(value.missing).toEqual(["p-error", "p-absent"]);
  });

  test("a date-only validTo ends at 23:59:59 Europe/Helsinki", async () => {
    const { live } = harness(() =>
      json(
        priceBody([
          priceItem("p-winter", {
            catalogPrice: { ...priceItem("x").catalogPrice, validTo: "2026-11-20" },
          }),
          priceItem("p-summer", {
            catalogPrice: { ...priceItem("x").catalogPrice, validTo: "2026-07-20" },
          }),
          priceItem("p-local", {
            catalogPrice: { ...priceItem("x").catalogPrice, validTo: "2026-11-20T10:00:00" },
          }),
        ]),
      ),
    );
    const value = await pricesOf(live, query(["p-winter", "p-summer", "p-local"]));
    const byId = new Map(value.quotes.map((quote) => [quote.productId, quote]));
    expect(new Date(byId.get("p-winter")?.validTo ?? "").toISOString()).toBe(
      "2026-11-20T21:59:59.000Z",
    );
    expect(new Date(byId.get("p-summer")?.validTo ?? "").toISOString()).toBe(
      "2026-07-20T20:59:59.000Z",
    );
    expect(byId.get("p-local")?.validTo).toBe("2026-11-20T10:00:00+02:00");
  });

  test("netPriceFound false still gives a price", async () => {
    const { live } = harness(() =>
      json(priceBody([priceItem("p-catalog", { netPriceFound: false })])),
    );
    const value = await pricesOf(live, query(["p-catalog"]));
    expect(value.quotes.map((quote) => quote.productId)).toEqual(["p-catalog"]);
    expect(value.missing).toEqual([]);
  });

  test("comparisonUnit KG maps to KGM and L to LTR", async () => {
    const { live } = harness(() =>
      json(
        priceBody([
          priceItem("p-kg", { comparisonUnit: "KG", comparisonPrice: { value: 3.2 } }),
          priceItem("p-l", { comparisonUnit: "L", comparisonPrice: { value: 1.1 } }),
          priceItem("p-other", { comparisonUnit: "ST", comparisonPrice: { value: 9 } }),
          priceItem("p-none", { comparisonUnit: "KG", comparisonPrice: null }),
        ]),
      ),
    );
    const value = await pricesOf(live, query(["p-kg", "p-l", "p-other", "p-none"]));
    const byId = new Map(value.quotes.map((quote) => [quote.productId, quote]));
    expect(byId.get("p-kg")?.comparisonPrice).toEqual({ value: 3.2, unit: "KGM" });
    expect(byId.get("p-l")?.comparisonPrice).toEqual({ value: 1.1, unit: "LTR" });
    expect(byId.get("p-other")?.comparisonPrice).toBeNull();
    expect(byId.get("p-none")?.comparisonPrice).toBeNull();
  });

  test("a null tax, an absent tax or a non-EUR currency makes only that product missing", async () => {
    const { tax: _tax, ...withoutTax } = priceItem("p-absent-tax");
    const { live } = harness(() =>
      json(
        priceBody([
          priceItem("p-valid"),
          priceItem("p-null-tax", { tax: null }),
          withoutTax,
          priceItem("p-sek", {
            catalogPrice: { ...priceItem("x").catalogPrice, currency: "SEK" },
          }),
          priceItem("p-error", { error: true, catalogPrice: {} }),
        ]),
      ),
    );
    const value = await pricesOf(
      live,
      query(["p-valid", "p-null-tax", "p-absent-tax", "p-sek", "p-error"]),
    );
    expect(value.quotes.map((quote) => quote.productId)).toEqual(["p-valid"]);
    expect(value.missing).toEqual(["p-null-tax", "p-absent-tax", "p-sek", "p-error"]);
  });
});

describe("live format", () => {
  test("a live-format response with +HHMM offsets and validTo 9999 maps to a quote (availability)", async () => {
    const { live } = harness(({ body }) =>
      json(
        body.requestedDate === "2026-11-16"
          ? {
              timeNow: "2026-11-14T13:29:56+0200",
              requestedDate: "2026-11-16T00:00:00+0200",
              products: [
                {
                  productId: "p-live",
                  closingTime: "2026-11-15T17:00:00+0200",
                  salesBlock: false,
                  logisticModel: "Stock",
                  scheduleLines: [
                    {
                      salesBlock: false,
                      availableAmount: 9999999999.0,
                      availableDate: "2026-11-16",
                      salesUnit: "ST",
                    },
                  ],
                },
              ],
            }
          : availabilityBody([]),
      ),
    );
    const value = await availabilityOf(live, query(["p-live"]));
    expect(value.missing).toEqual([]);
    expect(value.quotes).toEqual([
      {
        productId: "p-live",
        amount: 9999999999,
        availableDate: "2026-11-16",
        nextDeliveryDate: null,
        cutoffAt: "2026-11-15T17:00:00+02:00",
        salesBlocked: false,
        stock: "confirmed",
      },
    ]);
  });

  test("a live-format response with +HHMM offsets and validTo 9999 maps to a quote (price)", async () => {
    const window = {
      validFrom: "2026-09-01T00:00:00+0300",
      validTo: "9999-12-31T00:00:00+0200",
      currency: "EUR",
    };
    const { live } = harness(() =>
      json({
        customerId: "cust_test",
        currency: "EUR",
        pricingDate: "2026-11-16T00:00:00+0200",
        products: [
          {
            productId: "p-live",
            quantity: 1.0,
            catalogPrice: { value: 1.56, valueWithTax: 1.77, ...window },
            priceWithTax: { value: 1.77, ...window },
            comparisonPrice: { value: 1.56, valueWithTax: 1.77, ...window },
            comparisonUnit: "L",
            tax: { taxRate: 13.5, taxValue: 0.21 },
            listPrice: { value: 1.56, valueWithTax: 1.77, ...window },
            netPriceFound: false,
            error: false,
          },
        ],
      }),
    );
    const value = await pricesOf(live, query(["p-live"]));
    expect(value.missing).toEqual([]);
    expect(value.quotes).toEqual([
      {
        productId: "p-live",
        unitPrice: { net: 1.56, vatRate: 13.5, currency: "EUR" },
        deposit: 0,
        depositKnown: false,
        comparisonPrice: { value: 1.56, unit: "LTR" },
        validTo: "9999-12-31T00:00:00+02:00",
      },
    ]);
  });
});

describe("transport", () => {
  test("a transport error, a non-2xx answer or a body that fails the schema gives UPSTREAM_FAILED", async () => {
    const failing: [string, Responder][] = [
      [
        "transport",
        () => {
          throw new Error("connection refused");
        },
      ],
      ["non-2xx", () => json({ detail: "boom" }, 500)],
      ["422", () => json({ detail: [] }, 422)],
      ["schema", () => json({ products: "not a list" })],
      ["not json", () => new Response("<html>", { status: 200 })],
    ];
    for (const [label, responder] of failing) {
      const { live } = harness(responder);
      const availability = await live.getAvailability(query(["p-a"]));
      const prices = await live.getPrices(query(["p-a"]));
      expect(availability, label).toEqual({ ok: false, error: "UPSTREAM_FAILED" });
      expect(prices, label).toEqual({ ok: false, error: "UPSTREAM_FAILED" });
    }
  });

  for (const method of ["getAvailability", "getPrices"] as const) {
    test(`${method} retries a 429 and uses the successful quote`, async () => {
      const clock = fakeClock();
      let attempts = 0;
      const { live, calls } = harness(() => {
        attempts++;
        if (attempts === 1)
          return new Response(null, { status: 429, headers: { "Retry-After": "4" } });
        return json(
          method === "getPrices"
            ? priceBody([priceItem("p-retry")])
            : availabilityBody([
                product("p-retry", [line("2026-11-16T00:00:00"), line("2026-11-17T00:00:00")]),
              ]),
        );
      }, clock);
      const result = await live[method](query(["p-retry"]));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected a successful quote");
      expect(result.value.quotes.map((quote) => quote.productId)).toEqual(["p-retry"]);
      expect(calls).toHaveLength(2);
      expect(clock.waits).toEqual([4000]);
    });

    test(`${method} stops after three 429 responses`, async () => {
      const clock = fakeClock();
      const { live, calls } = harness(
        () => new Response(null, { status: 429, headers: { "Retry-After": "4" } }),
        clock,
      );
      expect(await live[method](query(["p-retry"]))).toEqual({
        ok: false,
        error: "UPSTREAM_FAILED",
      });
      expect(calls).toHaveLength(3);
      expect(clock.waits).toEqual([4000, 4000]);
    });

    test(`${method} uses the fallback for missing and invalid Retry-After`, async () => {
      for (const header of [null, "-1", "garbage"]) {
        const clock = fakeClock();
        const { live, calls } = harness(
          () =>
            new Response(null, {
              status: 429,
              headers: header === null ? {} : { "Retry-After": header },
            }),
          clock,
        );
        expect(await live[method](query(["p-retry"]))).toEqual({
          ok: false,
          error: "UPSTREAM_FAILED",
        });
        expect(calls).toHaveLength(3);
        expect(clock.waits).toEqual([1000, 1000]);
      }
    });

    test(`${method} honors an HTTP-date Retry-After`, async () => {
      const clock = fakeClock();
      const retryAt = new Date(clock.now() + 4000).toUTCString();
      const { live, calls } = harness(
        () => new Response(null, { status: 429, headers: { "Retry-After": retryAt } }),
        clock,
      );
      expect(await live[method](query(["p-retry"]))).toEqual({
        ok: false,
        error: "UPSTREAM_FAILED",
      });
      expect(calls).toHaveLength(3);
      expect(clock.waits).toEqual([4000, 0]);
    });

    test(`${method} does not shorten an oversized Retry-After`, async () => {
      const clock = fakeClock();
      const { live, calls } = harness(
        () => new Response(null, { status: 429, headers: { "Retry-After": "9" } }),
        clock,
      );
      expect(await live[method](query(["p-retry"]))).toEqual({
        ok: false,
        error: "UPSTREAM_FAILED",
      });
      expect(calls).toHaveLength(1);
      expect(clock.waits).toEqual([]);
    });

    test(`${method} includes request time in the single deadline`, async () => {
      const clock = fakeClock();
      const { live, calls } = harness(() => {
        clock.advance(2500);
        return new Response(null, { status: 429, headers: { "Retry-After": "4" } });
      }, clock);
      expect(await live[method](query(["p-retry"]))).toEqual({
        ok: false,
        error: "UPSTREAM_FAILED",
      });
      expect(calls).toHaveLength(2);
      expect(clock.waits).toEqual([4000]);
    });

    test(`${method} fails a 500 immediately`, async () => {
      const clock = fakeClock();
      const { live, calls } = harness(() => json({ detail: "boom" }, 500), clock);
      expect(await live[method](query(["p-retry"]))).toEqual({
        ok: false,
        error: "UPSTREAM_FAILED",
      });
      expect(calls).toHaveLength(1);
      expect(clock.waits).toEqual([]);
    });
  }

  test("a blocked earlier line does not block a later open line", async () => {
    const { live } = harness(({ body }) =>
      json(
        availabilityBody(
          body.requestedDate === "2026-11-16"
            ? [
                product("p-a", [
                  line("2026-11-15T00:00:00", 5, true),
                  line("2026-11-17T00:00:00", 5),
                ]),
                product("p-blocked", [line("2026-11-17T00:00:00", 5, true)]),
              ]
            : [],
        ),
      ),
    );
    const value = await availabilityOf(live, query(["p-a", "p-blocked"]));
    const byId = new Map(value.quotes.map((quote) => [quote.productId, quote]));
    expect(byId.get("p-a")).toMatchObject({ availableDate: "2026-11-17", salesBlocked: false });
    expect(byId.get("p-blocked")).toMatchObject({ availableDate: null, salesBlocked: true });
  });

  test("an unparsable closingTime makes only that product missing", async () => {
    const { live } = harness(({ body }) =>
      json(
        availabilityBody(
          body.requestedDate === "2026-11-16"
            ? [
                product("p-ok", [line("2026-11-16T00:00:00")], {
                  closingTime: "2026-11-15T08:30:00",
                }),
                product("p-garbage", [line("2026-11-16T00:00:00")], { closingTime: "tomorrow" }),
                product("p-date-only", [line("2026-11-16T00:00:00")], {
                  closingTime: "2026-11-15",
                }),
              ]
            : [],
        ),
      ),
    );
    const value = await availabilityOf(live, query(["p-ok", "p-garbage", "p-date-only"]));
    expect(value.quotes.map((quote) => quote.productId)).toEqual(["p-ok"]);
    expect(value.missing).toEqual(["p-garbage", "p-date-only"]);
  });

  test("a malformed availability item makes only that product missing", async () => {
    const { live } = harness(({ body }) =>
      json(
        availabilityBody(
          body.requestedDate === "2026-11-16"
            ? [
                product("p-ok", [line("2026-11-16T00:00:00")]),
                { ...product("p-bad", [line("2026-11-16T00:00:00")]), salesBlock: "yes" },
                { scheduleLines: [] },
              ]
            : [],
        ),
      ),
    );
    const value = await availabilityOf(live, query(["p-ok", "p-bad"]));
    expect(value.quotes.map((quote) => quote.productId)).toEqual(["p-ok"]);
    expect(value.missing).toEqual(["p-bad"]);
  });

  test("a failed further query gives a null nextDeliveryDate, not UPSTREAM_FAILED", async () => {
    const { live } = harness(({ body }) =>
      body.requestedDate === "2026-11-16"
        ? json(availabilityBody([product("p-a", [line("2026-11-17T00:00:00")])]))
        : json({}, 500),
    );
    const value = await availabilityOf(live, query(["p-a"]));
    expect(value.quotes[0]?.nextDeliveryDate).toBeNull();
  });

  test("requests send X-API-Key and the customer, requestedDate and products body", async () => {
    const { live, calls } = harness(({ path }) =>
      json(path === "/api/price" ? priceBody([]) : availabilityBody([])),
    );
    await live.getAvailability(query(["p-a", "p-b"]));
    await live.getPrices(query(["p-a", "p-b"]));
    expect(calls.map((call) => call.path)).toEqual(["/api/availability", "/api/price"]);
    for (const call of calls) {
      expect(call.headers.get("X-API-Key")).toBe("test-key");
      expect(call.body).toEqual({
        customer: "cust_test",
        requestedDate: "2026-11-16",
        products: ["p-a", "p-b"],
      });
    }
  });
});

describe("mockWholesalerFromEnv", () => {
  test("mockWholesalerFromEnv returns null without the API key", () => {
    expect(mockWholesalerFromEnv(() => undefined)).toBeNull();
    expect(mockWholesalerFromEnv((name) => (name === "OTHER" ? "x" : undefined))).toBeNull();
  });

  test("mockWholesalerFromEnv returns an adapter with the key", async () => {
    const live = mockWholesalerFromEnv((name) =>
      name === "VALIO_AIMO_API_KEY" ? "test-key" : undefined,
    );
    expect(live).not.toBeNull();
  });
});
