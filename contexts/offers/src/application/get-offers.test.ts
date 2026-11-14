import { describe, expect, test } from "bun:test";
import { err, type Result } from "@app/kernel";
import {
  fixtures,
  OfferClaimsSchema,
  OffersResultSchema,
  type AvailabilityQuote,
  type HardConstraint,
  type Mandate,
  type OfferClaims,
  type OffersRequest,
  type PriceQuote,
  type WholesalerLive,
} from "@app/contract";
import { offerExpiry } from "../domain/offer-rules.ts";
import {
  FAKE_ISSUER,
  fakeAvailability,
  fakeOffersDeps,
  fakePrice,
  fakeProduct,
  type FakeLiveData,
} from "./fakes.ts";
import { getOffers, NO_LIVE_SOURCE_DETAIL, PRECHECK_CONCURRENCY } from "./get-offers.ts";
import type { OfferSigner } from "./ports.ts";

// Invented products only (team rules R-23).
const OAT = "prod_test_oat";
const RYE = "prod_test_rye";
const principal = fixtures.account;
const lactose: HardConstraint = { attribute: "lactose", is: "free_from" };

const request = (patch: Partial<OffersRequest> = {}): OffersRequest => ({
  lines: [{ productId: OAT, quantity: { value: 4, unit: "CT" } }],
  deliverBy: "2026-11-20",
  paymentTerms: principal.paymentTerms,
  hard: [],
  soft: [],
  ...patch,
});

const line = (productId: string, value = 4, unit = "CT") => ({
  productId,
  quantity: { value, unit },
});

const quoted = (
  productId: string,
  availability: Partial<AvailabilityQuote> | null = {},
  price: Partial<PriceQuote> | null = {},
): FakeLiveData => ({
  [productId]: {
    ...(availability === null
      ? {}
      : { availability: { "*": fakeAvailability(productId, availability) } }),
    ...(price === null ? {} : { prices: { "*": fakePrice(productId, price) } }),
  },
});

const quotedAll = (ids: readonly string[]): FakeLiveData =>
  Object.fromEntries(ids.flatMap((id) => Object.entries(quoted(id))));

const mandate = (standingConstraints: Mandate["standingConstraints"]): Mandate => ({
  ...fixtures.storedMandate.mandate,
  standingConstraints,
});

const valueOf = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const reasons = (omitted: readonly { productId: string; reason: string }[]) =>
  Object.fromEntries(omitted.map((entry) => [entry.productId, entry.reason]));

describe("getOffers", () => {
  test("availability is read first and the price is requested for the actual delivery date", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT)],
      live: {
        [OAT]: {
          availability: { "2026-11-20": fakeAvailability(OAT, { availableDate: "2026-11-19" }) },
          prices: {
            "2026-11-19": fakePrice(OAT, { unitPrice: { net: 10, vatRate: 14, currency: "EUR" } }),
            "2026-11-20": fakePrice(OAT, { unitPrice: { net: 20, vatRate: 14, currency: "EUR" } }),
          },
        },
      },
    });

    const result = valueOf(await getOffers(setup.deps, principal, request()));

    expect(setup.live.calls.map((call) => [call.kind, call.query.requestedDate])).toEqual([
      ["availability", "2026-11-20"],
      ["prices", "2026-11-19"],
    ]);
    const [offer] = result.offers;
    expect(offer?.claims.unitPrice.net).toBe(10);
    expect(offer?.claims.deliveryDate).toBe("2026-11-19");
    expect(offer?.claims.requestedDate).toBe("2026-11-20");
  });

  test("paymentTerms other than the principal's gives 400", async () => {
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live: quoted(OAT) });

    const result = await getOffers(
      setup.deps,
      { ...principal, paymentTerms: "invoice" },
      request({ paymentTerms: "pay_on_order" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BAD_REQUEST");
    expect(setup.catalog.requests).toEqual([]);
    expect(setup.live.calls).toEqual([]);
  });

  test("an invalid quantity is omitted INVALID_QUANTITY and an unknown product UNKNOWN_PRODUCT", async () => {
    const LOT = "prod_test_lot";
    const UNKNOWN = "prod_test_unknown";
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT), fakeProduct(RYE), fakeProduct(LOT, { allowedLotSize: 6 })],
      live: { ...quoted(OAT), ...quoted(RYE), ...quoted(LOT) },
    });

    const result = valueOf(
      await getOffers(
        setup.deps,
        principal,
        request({
          lines: [line(OAT, 4, "LTR"), line(LOT, 4), line(RYE, 0), line(UNKNOWN), line(OAT, 2)],
        }),
      ),
    );

    expect(result.omitted.map((entry) => [entry.productId, entry.reason])).toEqual([
      [OAT, "INVALID_QUANTITY"],
      [LOT, "INVALID_QUANTITY"],
      [RYE, "INVALID_QUANTITY"],
      [UNKNOWN, "UNKNOWN_PRODUCT"],
    ]);
    expect(result.offers.map((offer) => offer.claims.quantity)).toEqual([{ value: 2, unit: "CT" }]);
    expect(setup.live.calls.map((call) => call.query.productIds)).toEqual([[OAT], [OAT]]);
  });

  test("a contradicted standing constraint is omitted CONSTRAINT_CONTRADICTED", async () => {
    const setup = fakeOffersDeps({
      mandate: mandate({ hard: [lactose], soft: [] }),
      products: [
        fakeProduct(OAT, { match: { lactose: "contradicted" } }),
        fakeProduct(RYE, { match: { lactose: "confirmed" } }),
      ],
      live: { ...quoted(OAT), ...quoted(RYE) },
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: [line(OAT), line(RYE)], hard: [] })),
    );

    expect(setup.catalog.requests.map((req) => req.hard)).toEqual([[lactose]]);
    expect(reasons(result.omitted)).toEqual({ [OAT]: "CONSTRAINT_CONTRADICTED" });
    expect(result.omitted[0]?.detail).toContain("lactose");
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([RYE]);
  });

  test("confirmed amount below the request is omitted INSUFFICIENT_STOCK", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT), fakeProduct(RYE)],
      live: { ...quoted(OAT, { amount: 3, stock: "confirmed" }), ...quoted(RYE, { amount: 4 }) },
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: [line(OAT, 4), line(RYE, 4)] })),
    );

    expect(reasons(result.omitted)).toEqual({ [OAT]: "INSUFFICIENT_STOCK" });
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([RYE]);
    expect(
      setup.live.calls.filter((call) => call.kind === "prices").map((c) => c.query.productIds),
    ).toEqual([[RYE]]);
  });

  test("no price, a sales block or no date is omitted NO_PRICE, SALES_BLOCKED, NO_DELIVERY_DATE", async () => {
    const NO_PRICE = "prod_test_no_price";
    const BLOCKED = "prod_test_blocked";
    const NO_DATE = "prod_test_no_date";
    const NO_QUOTE = "prod_test_no_quote";
    const ids = [NO_PRICE, BLOCKED, NO_DATE, NO_QUOTE, OAT];
    const setup = fakeOffersDeps({
      products: ids.map((id) => fakeProduct(id)),
      live: {
        ...quoted(NO_PRICE, {}, null),
        ...quoted(BLOCKED, { salesBlocked: true, availableDate: null }),
        ...quoted(NO_DATE, { availableDate: null }),
        ...quoted(NO_QUOTE, null),
        ...quoted(OAT),
      },
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: ids.map((id) => line(id)) })),
    );

    expect(reasons(result.omitted)).toEqual({
      [NO_PRICE]: "NO_PRICE",
      [BLOCKED]: "SALES_BLOCKED",
      [NO_DATE]: "NO_DELIVERY_DATE",
      [NO_QUOTE]: "NO_DELIVERY_DATE",
    });
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([OAT]);
    expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([OAT]);
  });

  test("with no live wholesaler configured, every line is omitted NO_PRICE and nothing is signed", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT), fakeProduct(RYE)],
      live: quotedAll([OAT, RYE]),
    });

    const result = valueOf(
      await getOffers(
        { ...setup.deps, live: null },
        principal,
        request({ lines: [line(OAT), line(RYE), line("prod_test_unknown")] }),
      ),
    );

    expect(result).toEqual({
      offers: [],
      omitted: [OAT, RYE, "prod_test_unknown"].map((productId) => ({
        productId,
        reason: "NO_PRICE",
        detail: NO_LIVE_SOURCE_DETAIL,
      })),
    });
    expect(OffersResultSchema.safeParse(result).success).toBe(true);
    expect(setup.signer.signed).toEqual([]);
    expect(setup.orders.calls).toEqual([]);
    expect(setup.catalog.requests).toEqual([]);
    expect(setup.live.calls).toEqual([]);
  });

  test("999999 gives stock unconfirmed", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT)],
      live: quoted(OAT, { amount: 999_999, stock: "unconfirmed" }),
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: [line(OAT, 1_000_000)] })),
    );

    expect(result.omitted).toEqual([]);
    expect(result.offers[0]?.claims.stock).toBe("unconfirmed");
  });

  test("precheck is null when orders answers 501 or is unreachable", async () => {
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live: quoted(OAT) });

    const answered = valueOf(await getOffers(setup.deps, principal, request()));
    setup.orders.answerWith(err("UNAVAILABLE"));
    const failed = valueOf(await getOffers(setup.deps, principal, request()));

    expect(answered.offers[0]?.precheck).toEqual(fixtures.precheck);
    expect(failed.offers).toHaveLength(1);
    expect(failed.offers[0]?.precheck).toBeNull();
    expect(setup.orders.calls).toEqual(["fake.off_test_1", "fake.off_test_2"]);
  });

  test("a second request within validTo makes no upstream call", async () => {
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live: quoted(OAT) });

    const first = valueOf(await getOffers(setup.deps, principal, request()));
    const callsAfterFirst = setup.live.calls.length;
    setup.clock.set("2026-11-18T07:59:59Z");
    const second = valueOf(await getOffers(setup.deps, principal, request()));

    expect(callsAfterFirst).toBe(2);
    expect(setup.live.calls).toHaveLength(2);
    expect(second.offers[0]?.claims.unitPrice).toEqual(first.offers[0]?.claims.unitPrice);
    expect(setup.signer.signed).toHaveLength(2);
  });

  test("a cached quote is not served after validTo, and after cutoffAt it gives NO_DELIVERY_DATE without an upstream call", async () => {
    const stale = fakeOffersDeps({
      products: [fakeProduct(OAT)],
      live: quoted(
        OAT,
        { cutoffAt: "2026-11-18T00:00:00+00:00" },
        { validTo: "2026-11-16T10:00:00+00:00" },
      ),
    });
    valueOf(await getOffers(stale.deps, principal, request()));
    stale.clock.set("2026-11-16T10:00:00Z");
    valueOf(await getOffers(stale.deps, principal, request()));

    expect(stale.live.calls.map((call) => call.kind)).toEqual([
      "availability",
      "prices",
      "availability",
      "prices",
    ]);

    const cut = fakeOffersDeps({
      products: [fakeProduct(OAT)],
      live: quoted(
        OAT,
        { cutoffAt: "2026-11-16T10:00:00+00:00" },
        { validTo: "2026-11-18T00:00:00+00:00" },
      ),
    });
    valueOf(await getOffers(cut.deps, principal, request()));
    cut.clock.set("2026-11-16T10:00:00Z");
    const afterCutoff = valueOf(await getOffers(cut.deps, principal, request()));

    expect(cut.live.calls).toHaveLength(2);
    expect(afterCutoff.offers).toEqual([]);
    expect(reasons(afterCutoff.omitted)).toEqual({ [OAT]: "NO_DELIVERY_DATE" });
    expect(cut.signer.signed).toHaveLength(1);
  });

  test("an omitted line is not cached", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT)],
      live: quoted(OAT, { amount: 3 }),
    });

    await getOffers(setup.deps, principal, request());
    await getOffers(setup.deps, principal, request());

    expect(setup.live.calls.map((call) => call.kind)).toEqual(["availability", "availability"]);
  });

  test("claims carry customer, agentId and paymentTerms of the principal, the mandate id and version, the merged constraints and iss from the issuer, and parse with OfferClaimsSchema", async () => {
    const standing = { attribute: "countryOfOrigin", prefer: "fi" };
    const asked = { attribute: "organic", prefer: "yes" };
    const current = mandate({ hard: [lactose], soft: [standing] });
    const setup = fakeOffersDeps({
      mandate: current,
      products: [fakeProduct(OAT, { match: { lactose: "confirmed" } })],
      live: quoted(OAT),
    });
    const returned: OfferClaims[] = [];
    const signer: OfferSigner = {
      jwks: () => setup.signer.jwks(),
      async sign(claims, exp) {
        const minted = await setup.signer.sign(claims, exp);
        returned.push(minted.claims);
        return minted;
      },
    };

    const result = valueOf(
      await getOffers({ ...setup.deps, signer }, principal, request({ soft: [asked] })),
    );

    const claims = result.offers[0]?.claims;
    expect(claims).toBeDefined();
    expect(claims).toBe(returned[0]);
    expect(OfferClaimsSchema.safeParse(claims).success).toBe(true);
    expect(claims).toMatchObject({
      iss: FAKE_ISSUER,
      offerId: "off_test_1",
      customer: principal.customer,
      agentId: principal.agentId,
      paymentTerms: principal.paymentTerms,
      mandateId: current.mandateId,
      mandateVersion: current.version,
      constraints: { hard: [lactose], soft: [asked, standing] },
      quantity: { value: 4, unit: "CT" },
      total: { net: 40, gross: 45.6 },
      deposits: 0,
      replaces: null,
      shortfall: null,
    });
    expect(result.offers[0]?.offerId).toBe("off_test_1");
    expect(result.offers[0]?.token).toBe("fake.off_test_1");
    const quote = fakeAvailability(OAT);
    expect(setup.signer.signed[0]?.exp).toEqual(
      offerExpiry(fakePrice(OAT).validTo, quote.cutoffAt),
    );
  });

  test("claims carry null mandate id and version and the request constraints when no mandate exists", async () => {
    const setup = fakeOffersDeps({
      mandate: null,
      products: [fakeProduct(OAT)],
      live: quoted(OAT),
    });

    const result = valueOf(await getOffers(setup.deps, principal, request({ hard: [lactose] })));

    expect(result.offers[0]?.claims).toMatchObject({
      mandateId: null,
      mandateVersion: null,
      constraints: { hard: [lactose], soft: [] },
    });
  });

  test("upstream failure gives UPSTREAM_FAILED for the live port", async () => {
    for (const kind of ["availability", "prices"] as const) {
      const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live: quoted(OAT) });
      setup.live.failWith(true, kind);

      const result = await getOffers(setup.deps, principal, request());

      expect(result.ok ? null : result.error.code).toBe("UPSTREAM_FAILED");
      expect(setup.signer.signed).toEqual([]);
    }
  });

  test("upstream failure gives UPSTREAM_FAILED for the catalog port", async () => {
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live: quoted(OAT) });
    setup.catalog.fail(true);

    const result = await getOffers(setup.deps, principal, request());

    expect(result.ok ? null : result.error.code).toBe("UPSTREAM_FAILED");
    expect(setup.live.calls).toEqual([]);
  });

  test("upstream failure gives UPSTREAM_FAILED for the mandate port", async () => {
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live: quoted(OAT) });
    setup.mandates.fail(true);

    const result = await getOffers(setup.deps, principal, request());

    expect(result.ok ? null : result.error.code).toBe("UPSTREAM_FAILED");
    expect(setup.catalog.requests).toEqual([]);
  });

  test("the result parses with OffersResultSchema", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT), fakeProduct(RYE)],
      live: { ...quoted(OAT), ...quoted(RYE, { salesBlocked: true }) },
    });

    const result = valueOf(
      await getOffers(
        setup.deps,
        principal,
        request({ lines: [line(OAT), line(RYE), line("prod_test_unknown")] }),
      ),
    );

    expect(result.offers).toHaveLength(1);
    expect(result.omitted).toHaveLength(2);
    expect(OffersResultSchema.safeParse(result).success).toBe(true);
  });

  test("a quote that expires at or before now is omitted, not signed", async () => {
    const CUT = "prod_test_cut";
    const STALE = "prod_test_stale";
    const BOTH = "prod_test_both";
    const ids = [CUT, STALE, BOTH, OAT];
    const setup = fakeOffersDeps({
      now: "2026-11-14T10:00:00Z",
      products: ids.map((id) => fakeProduct(id)),
      live: {
        ...quoted(CUT, { cutoffAt: "2026-11-14T12:00:00+02:00" }),
        ...quoted(STALE, {}, { validTo: "2026-11-14T09:59:59+00:00" }),
        ...quoted(
          BOTH,
          { cutoffAt: "2026-11-14T09:00:00+00:00" },
          { validTo: "2026-11-14T10:00:00+00:00" },
        ),
        ...quoted(OAT),
      },
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: ids.map((id) => line(id)) })),
    );

    expect(reasons(result.omitted)).toEqual({
      [CUT]: "NO_DELIVERY_DATE",
      [STALE]: "NO_PRICE",
      [BOTH]: "NO_DELIVERY_DATE",
    });
    expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([OAT]);
  });

  test("a quote that expires during the upstream calls is omitted, not signed", async () => {
    const setup = fakeOffersDeps({
      now: "2026-11-14T10:00:00Z",
      products: [fakeProduct(OAT)],
      live: quoted(OAT, { cutoffAt: "2026-11-14T10:00:30+00:00" }),
    });
    const live: WholesalerLive = {
      getAvailability: (query) => setup.live.getAvailability(query),
      async getPrices(query) {
        setup.clock.set("2026-11-14T10:00:30Z");
        return setup.live.getPrices(query);
      },
    };

    const result = valueOf(await getOffers({ ...setup.deps, live }, principal, request()));

    expect(reasons(result.omitted)).toEqual({ [OAT]: "NO_DELIVERY_DATE" });
    expect(result.offers).toEqual([]);
    expect(setup.signer.signed).toEqual([]);
  });

  test("a fractional deadline that floors to now is omitted", async () => {
    const CUT = "prod_test_cut";
    const STALE = "prod_test_stale";
    const ids = [CUT, STALE, OAT];
    const setup = fakeOffersDeps({
      now: "2026-11-14T10:00:00.200Z",
      products: ids.map((id) => fakeProduct(id)),
      live: {
        ...quoted(CUT, { cutoffAt: "2026-11-14T10:00:00.900+00:00" }),
        ...quoted(STALE, {}, { validTo: "2026-11-14T10:00:00.500+00:00" }),
        ...quoted(OAT, { cutoffAt: "2026-11-14T10:00:01.000+00:00" }),
      },
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: ids.map((id) => line(id)) })),
    );

    expect(reasons(result.omitted)).toEqual({ [CUT]: "NO_DELIVERY_DATE", [STALE]: "NO_PRICE" });
    expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([OAT]);
    expect(result.offers[0]?.claims).toMatchObject({
      iat: Date.parse("2026-11-14T10:00:00Z") / 1000,
      exp: Date.parse("2026-11-14T10:00:01Z") / 1000,
    });
  });

  test("an offer whose deadline passes during signing is omitted", async () => {
    const STALE = "prod_test_stale";
    const ids = [OAT, STALE, RYE];
    const setup = fakeOffersDeps({
      now: "2026-11-14T10:00:00Z",
      products: ids.map((id) => fakeProduct(id)),
      live: {
        ...quoted(OAT, { cutoffAt: "2026-11-14T10:00:05+00:00" }),
        ...quoted(STALE, {}, { validTo: "2026-11-14T10:00:05+00:00" }),
        ...quoted(RYE),
      },
    });
    const signer: OfferSigner = {
      jwks: () => setup.signer.jwks(),
      async sign(claims, exp) {
        setup.clock.set("2026-11-14T10:00:05Z");
        return setup.signer.sign(claims, exp);
      },
    };

    const result = valueOf(
      await getOffers(
        { ...setup.deps, signer },
        principal,
        request({ lines: ids.map((id) => line(id)) }),
      ),
    );

    expect(setup.signer.signed).toHaveLength(3);
    expect(reasons(result.omitted)).toEqual({ [OAT]: "NO_DELIVERY_DATE", [STALE]: "NO_PRICE" });
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([RYE]);
    expect(OffersResultSchema.safeParse(result).success).toBe(true);
  });

  test("an availableDate later than deliverBy still gives an offer with that delivery date", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT)],
      live: quoted(OAT, { availableDate: "2026-11-24", nextDeliveryDate: "2026-11-26" }),
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ deliverBy: "2026-11-20" })),
    );

    expect(result.omitted).toEqual([]);
    expect(result.offers[0]?.claims).toMatchObject({
      deliveryDate: "2026-11-24",
      requestedDate: "2026-11-20",
      nextDeliveryDate: "2026-11-26",
    });
    expect(setup.live.calls.map((call) => [call.kind, call.query.requestedDate])).toEqual([
      ["availability", "2026-11-20"],
      ["prices", "2026-11-24"],
    ]);
  });

  test("an offer served from the cache carries the same claims except iat/exp and a new offerId", async () => {
    const setup = fakeOffersDeps({
      now: "2026-11-14T10:00:00Z",
      products: [fakeProduct(OAT)],
      live: quoted(OAT),
    });

    const first = valueOf(await getOffers(setup.deps, principal, request()));
    setup.clock.set("2026-11-15T10:00:00Z");
    const second = valueOf(await getOffers(setup.deps, principal, request()));

    const firstClaims = first.offers[0]?.claims;
    if (firstClaims === undefined) throw new Error("expected a first offer");
    expect(setup.live.calls).toHaveLength(2);
    // exp is unchanged because it comes from the same cached validTo and cutoffAt.
    expect(second.offers[0]?.claims).toEqual({
      ...firstClaims,
      offerId: "off_test_2",
      iat: Date.parse("2026-11-15T10:00:00Z") / 1000,
      exp: firstClaims.exp,
    });
    expect(second.offers[0]?.offerId).toBe("off_test_2");
    expect(second.offers[0]?.token).toBe("fake.off_test_2");
    expect(firstClaims.iat).toBe(Date.parse("2026-11-14T10:00:00Z") / 1000);
  });

  test("1,001 distinct products give availability and price calls of at most 1,000 ids, and a repeated product id is queried once", async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `prod_test_bulk_${index}`);
    const live = quotedAll(ids);
    const setup = fakeOffersDeps({ products: ids.map((id) => fakeProduct(id)), live });

    const result = valueOf(
      await getOffers(
        setup.deps,
        principal,
        request({ lines: [...ids.map((id) => line(id)), line(ids[0] ?? OAT, 2)] }),
      ),
    );

    for (const kind of ["availability", "prices"] as const) {
      const queried = setup.live.calls
        .filter((call) => call.kind === kind)
        .map((call) => call.query.productIds);
      expect(queried.map((batch) => batch.length)).toEqual([1000, 1]);
      expect(queried.flat().toSorted()).toEqual(ids.toSorted());
    }
    expect(setup.catalog.requests[0]?.productIds).toHaveLength(1001);
    expect(result.offers).toHaveLength(1002);
  });

  test("ten offers run at most 4 prechecks at a time", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `prod_test_ten_${index}`);
    const live = quotedAll(ids);
    const setup = fakeOffersDeps({ products: ids.map((id) => fakeProduct(id)), live });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: ids.map((id) => line(id)) })),
    );

    expect(PRECHECK_CONCURRENCY).toBe(4);
    expect(setup.orders.calls).toHaveLength(10);
    expect(setup.orders.maxInFlight).toBe(4);
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual(ids);
    expect(result.offers.every((offer) => offer.precheck !== null)).toBe(true);
  });
});
