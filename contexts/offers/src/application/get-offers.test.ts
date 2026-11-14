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

  test("confirmed partial stock produces a reduced offer and signed shortfall", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT), fakeProduct(RYE)],
      live: { ...quoted(OAT, { amount: 3, stock: "confirmed" }), ...quoted(RYE, { amount: 4 }) },
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: [line(OAT, 4), line(RYE, 4)] })),
    );

    expect(result.omitted).toEqual([]);
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([OAT, RYE]);
    expect(result.offers[0]?.claims).toMatchObject({
      quantity: { value: 3, unit: "CT" },
      shortfall: { value: 1, unit: "CT" },
      total: { net: 30, gross: 34.2 },
    });
    expect(
      setup.live.calls.filter((call) => call.kind === "prices").map((c) => c.query.productIds),
    ).toEqual([[OAT, RYE]]);
  });

  test("fractional substitute stock covers three lots despite multiplication noise", async () => {
    const sub = "prod_test_fractional_sub";
    const setup = fakeOffersDeps({
      products: [
        fakeProduct(OAT, { perSalesUnit: { value: 0.1, unit: "LTR" }, substitutes: [sub] }),
        fakeProduct(sub, { perSalesUnit: { value: 1, unit: "LTR" }, allowedLotSize: 0.1 }),
      ],
      live: {
        ...quoted(OAT, { amount: 1 }),
        ...quoted(sub, { amount: 0.3, stock: "confirmed" }),
      },
    });

    const result = valueOf(await getOffers(setup.deps, principal, request()));
    const substitute = result.offers.find((offer) => offer.claims.productId === sub);
    expect(substitute?.claims.quantity.value).toBeCloseTo(0.3, 12);
    expect(substitute?.claims.replaces).toBe(OAT);
    expect(
      setup.signer.signed.find((entry) => entry.claims.productId === sub)?.claims.replaces,
    ).toBe(OAT);
  });

  test("generated decimal substitute lots require full confirmed stock", async () => {
    const sub = "prod_test_generated_sub";
    const scale = 1000;
    for (const lotTicks of [10, 25, 100, 125, 250]) {
      for (const lots of [2, 3, 7, 11]) {
        const lot = lotTicks / scale;
        const required = (lotTicks * lots) / scale;
        for (const covered of [true, false]) {
          const setup = fakeOffersDeps({
            products: [
              fakeProduct(OAT, { perSalesUnit: { value: lot, unit: "LTR" }, substitutes: [sub] }),
              fakeProduct(sub, { perSalesUnit: { value: 1, unit: "LTR" }, allowedLotSize: lot }),
            ],
            live: {
              ...quoted(OAT, { amount: 1 }),
              ...quoted(sub, {
                amount: covered ? required : (lotTicks * lots - lotTicks / 2) / scale,
                stock: "confirmed",
              }),
            },
          });
          const result = valueOf(
            await getOffers(setup.deps, principal, request({ lines: [line(OAT, lots + 1)] })),
          );
          const substitutes = result.offers.filter((offer) => offer.claims.replaces === OAT);
          expect(substitutes).toHaveLength(covered ? 1 : 0);
          expect(result.offers.some((offer) => offer.claims.productId === OAT)).toBe(true);
          if (covered) {
            expect(substitutes[0]?.claims.quantity.value).toBeCloseTo(required, 12);
            expect(setup.signer.signed.some((entry) => entry.claims.replaces === OAT)).toBe(true);
          } else {
            expect(setup.signer.signed.some((entry) => entry.claims.replaces === OAT)).toBe(false);
          }
        }
      }
    }
  });

  test("generated near-equal decimal originals retain substitutes with exactly enough stock", async () => {
    const sub = "prod_test_composed_sub";
    const scale = 1000;
    for (const lotTicks of [50, 100, 125, 250]) {
      for (const conversion of [1, 2]) {
        for (const requestedLots of [3, 7, 44, 83]) {
          for (const missingLots of [1, 2]) {
            const requested = (requestedLots * lotTicks) / scale;
            const available = ((requestedLots - missingLots) * lotTicks) / scale;
            const setup = fakeOffersDeps({
              products: [
                fakeProduct(OAT, {
                  allowedLotSize: lotTicks / scale,
                  perSalesUnit: { value: conversion, unit: "LTR" },
                  substitutes: [sub],
                }),
                fakeProduct(sub, {
                  perSalesUnit: { value: (lotTicks * conversion) / scale, unit: "LTR" },
                }),
              ],
              live: {
                ...quoted(OAT, { amount: available, stock: "confirmed" }),
                ...quoted(sub, { amount: missingLots, stock: "confirmed" }),
              },
            });
            const result = valueOf(
              await getOffers(setup.deps, principal, request({ lines: [line(OAT, requested)] })),
            );
            expect(result.omitted).toEqual([]);
            const original = result.offers.find((offer) => offer.claims.productId === OAT);
            const substitutes = result.offers.filter((offer) => offer.claims.replaces === OAT);
            expect(original?.claims.quantity.value).toBeCloseTo(available, 12);
            expect(original?.claims.shortfall?.value).toBeCloseTo(
              (missingLots * lotTicks * conversion) / scale,
              12,
            );
            expect(substitutes).toHaveLength(1);
            expect(substitutes[0]?.claims.quantity).toEqual({ value: missingLots, unit: "CT" });
            expect(setup.signer.signed.some((entry) => entry.claims.replaces === OAT)).toBe(true);
          }
        }
      }
    }
  });

  test("generated full and excess decimal stock never creates a phantom shortfall", async () => {
    const sub = "prod_test_full_stock_sub";
    const scale = 1000;
    for (const lotTicks of [100, 125, 300, 350]) {
      for (const lots of [3, 7, 11, 44]) {
        const requested = (lots * lotTicks) / scale;
        for (const extraTicks of [0, lotTicks]) {
          const setup = fakeOffersDeps({
            products: [
              fakeProduct(OAT, {
                allowedLotSize: lotTicks / scale,
                perSalesUnit: { value: 1, unit: "LTR" },
                substitutes: [sub],
              }),
              fakeProduct(sub, { perSalesUnit: { value: 1, unit: "LTR" } }),
            ],
            live: {
              ...quoted(OAT, { amount: (lots * lotTicks + extraTicks) / scale }),
              ...quoted(sub),
            },
          });
          const result = valueOf(
            await getOffers(setup.deps, principal, request({ lines: [line(OAT, requested)] })),
          );
          expect(result.omitted).toEqual([]);
          expect(result.offers).toHaveLength(1);
          expect(result.offers[0]?.claims).toMatchObject({
            productId: OAT,
            quantity: { value: requested, unit: "CT" },
            shortfall: null,
            replaces: null,
          });
          expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([OAT]);
        }
      }
    }
  });

  test("large decimal lot requests distinguish full stock from a one-lot shortfall", async () => {
    const sub = "prod_test_large_decimal_sub";
    for (const lotTicks of [1n, 10n, 125n]) {
      const lot = Number(lotTicks) / 100;
      for (const count of [11191318n, 600000000000n]) {
        const requested = Number(count * lotTicks) / 100;
        const available = Number((count - 1n) * lotTicks) / 100;
        for (const full of [true, false]) {
          const setup = fakeOffersDeps({
            products: [
              fakeProduct(OAT, {
                allowedLotSize: lot,
                perSalesUnit: { value: 0.25, unit: "LTR" },
                substitutes: [sub],
              }),
              fakeProduct(sub, {
                allowedLotSize: lot,
                perSalesUnit: { value: 0.25, unit: "LTR" },
              }),
            ],
            live: {
              ...quoted(OAT, { amount: full ? requested : available, stock: "confirmed" }),
              ...quoted(sub, { amount: lot, stock: "confirmed" }),
            },
          });
          const result = valueOf(
            await getOffers(setup.deps, principal, request({ lines: [line(OAT, requested)] })),
          );
          const original = result.offers.find((offer) => offer.claims.productId === OAT);
          const substitutes = result.offers.filter((offer) => offer.claims.replaces === OAT);
          expect(original?.claims.quantity.value).toBe(full ? requested : available);
          if (full) {
            expect(original?.claims.shortfall).toBeNull();
            expect(substitutes).toHaveLength(0);
            expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([OAT]);
          } else {
            expect(original?.claims.shortfall?.value).toBeCloseTo(
              Number(lotTicks * 25n) / 10000,
              6,
            );
            expect(substitutes).toHaveLength(1);
            expect(substitutes[0]?.claims.quantity).toEqual({ value: lot, unit: "CT" });
          }
        }
      }
    }
  });

  test("shared substitutes are looked up once but ranked and signed for each requested occurrence", async () => {
    const sub = "prod_test_sub";
    const perSalesUnit = { value: 1, unit: "LTR" };
    const setup = fakeOffersDeps({
      products: [
        fakeProduct(OAT, { perSalesUnit, substitutes: [sub, sub] }),
        fakeProduct(RYE, { perSalesUnit, substitutes: [sub] }),
        fakeProduct(sub, { perSalesUnit }),
      ],
      live: { ...quoted(OAT, { amount: 2 }), ...quoted(RYE, { amount: 3 }), ...quoted(sub) },
    });
    const req = request({ lines: [line(OAT, 4), line(OAT, 5), line(RYE, 4)] });
    const first = valueOf(await getOffers(setup.deps, principal, req));
    const substitutes = first.offers.filter((offer) => offer.claims.replaces !== null);
    expect(
      substitutes.map((offer) => [offer.claims.replaces, offer.claims.quantity.value]),
    ).toEqual([
      [OAT, 2],
      [OAT, 3],
      [RYE, 1],
    ]);
    expect(substitutes.every((offer) => offer.rank === "best" && offer.comparison !== null)).toBe(
      true,
    );
    expect(setup.catalog.requests.map((query) => query.productIds)).toEqual([[OAT, RYE], [sub]]);
    expect(setup.live.calls.filter((call) => call.query.productIds.includes(sub))).toHaveLength(2);
    const calls = setup.live.calls.length;
    const second = valueOf(
      await getOffers(setup.deps, principal, request({ lines: [line(OAT, 6)] })),
    );
    expect(setup.live.calls.slice(calls).map((call) => call.kind)).toEqual([
      "availability",
      "availability",
    ]);
    expect(
      second.offers.find((offer) => offer.claims.replaces === OAT)?.claims.quantity.value,
    ).toBe(4);
  });

  test("invalid partial originals do not trigger substitute lookups for healthy lines", async () => {
    const sub = "prod_test_unused_sub";
    const expired = "prod_test_expired";
    const huge = "prod_test_huge_partial";
    const perSalesUnit = { value: 1, unit: "LTR" };
    const setup = fakeOffersDeps({
      products: [
        ...[OAT, expired, huge].map((id) => fakeProduct(id, { perSalesUnit, substitutes: [sub] })),
        fakeProduct(RYE),
        fakeProduct(sub, { perSalesUnit }),
      ],
      live: {
        ...quoted(OAT, { amount: 2 }, null),
        ...quoted(expired, { amount: 2 }, { validTo: "2026-11-14T10:00:00Z" }),
        ...quoted(huge, { amount: 2 }, { unitPrice: { net: 1e308, vatRate: 14, currency: "EUR" } }),
        ...quoted(RYE),
      },
    });
    const result = valueOf(
      await getOffers(
        setup.deps,
        principal,
        request({ lines: [line(OAT), line(expired), line(huge), line(RYE)] }),
      ),
    );

    expect(reasons(result.omitted)).toEqual({
      [OAT]: "NO_PRICE",
      [expired]: "NO_PRICE",
      [huge]: "INVALID_QUANTITY",
    });
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([RYE]);
    expect(setup.catalog.requests.map((query) => query.productIds)).toEqual([
      [OAT, expired, huge, RYE],
    ]);
    expect(setup.live.calls.every((call) => !call.query.productIds.includes(sub))).toBe(true);
    expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([RYE]);
  });

  test("surviving substitutes are reranked separately for each occurrence after precheck", async () => {
    const best = "prod_test_expiring_best";
    const shared = "prod_test_shared_survivor";
    const perSalesUnit = { value: 1, unit: "LTR" };
    const setup = fakeOffersDeps({
      products: [
        fakeProduct(OAT, { perSalesUnit, substitutes: [best, shared] }),
        fakeProduct(RYE, { perSalesUnit, substitutes: [shared] }),
        fakeProduct(best, { perSalesUnit }),
        fakeProduct(shared, { perSalesUnit }),
      ],
      live: {
        ...quoted(OAT, { amount: 2 }),
        ...quoted(RYE, { amount: 3 }),
        ...quoted(
          best,
          { cutoffAt: "2026-11-14T10:00:05Z" },
          { unitPrice: { net: 1, vatRate: 14, currency: "EUR" } },
        ),
        ...quoted(shared, {}, { unitPrice: { net: 2, vatRate: 14, currency: "EUR" } }),
      },
    });
    const orders = {
      async precheck(token: string) {
        setup.clock.set("2026-11-14T10:00:05Z");
        return setup.orders.precheck(token);
      },
    };
    const result = valueOf(
      await getOffers(
        { ...setup.deps, orders },
        principal,
        request({ lines: [line(OAT, 4), line(OAT, 5), line(RYE, 4)] }),
      ),
    );
    const substitutes = result.offers.filter((offer) => offer.claims.replaces !== null);
    expect(
      substitutes.map((offer) => [
        offer.claims.productId,
        offer.claims.replaces,
        offer.claims.quantity.value,
        offer.rank,
      ]),
    ).toEqual([
      [shared, OAT, 2, "best"],
      [shared, OAT, 3, "best"],
      [shared, RYE, 1, "best"],
    ]);
    expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([
      OAT,
      OAT,
      RYE,
      best,
      shared,
      best,
      shared,
      shared,
    ]);
    expect(setup.signer.signed.filter((entry) => entry.claims.productId === best)).toHaveLength(2);
    expect(substitutes.every((offer) => offer.comparison !== null)).toBe(true);
  });

  test("an original expiring during signing cannot leave an orphan or have its omission overwritten", async () => {
    const sub = "prod_test_sub";
    const perSalesUnit = { value: 1, unit: "LTR" };
    const setup = fakeOffersDeps({
      products: [
        fakeProduct(OAT, { perSalesUnit, substitutes: [sub] }),
        fakeProduct(sub, { perSalesUnit }),
      ],
      live: {
        ...quoted(OAT, { amount: 2, cutoffAt: "2026-11-14T10:00:05Z" }),
        ...quoted(sub),
      },
    });
    const signer: OfferSigner = {
      jwks: () => setup.signer.jwks(),
      async sign(claims, exp) {
        setup.clock.set("2026-11-14T10:00:05Z");
        return setup.signer.sign(claims, exp);
      },
    };
    const result = valueOf(await getOffers({ ...setup.deps, signer }, principal, request()));
    expect(result.offers).toEqual([]);
    expect(reasons(result.omitted)).toEqual({ [OAT]: "NO_DELIVERY_DATE" });
    expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([OAT, sub]);
    expect(setup.signer.signed[1]?.exp.getTime()).toBeGreaterThan(
      Date.parse("2026-11-14T10:00:05Z"),
    );
  });

  test("a substitute lookup failure happens before any offer is signed", async () => {
    const sub = "prod_test_sub";
    const perSalesUnit = { value: 1, unit: "LTR" };
    const setup = fakeOffersDeps({
      products: [
        fakeProduct(OAT, { perSalesUnit, substitutes: [sub] }),
        fakeProduct(sub, { perSalesUnit }),
      ],
      live: { ...quoted(OAT, { amount: 2 }), ...quoted(sub) },
    });
    const live: WholesalerLive = {
      getAvailability: (query) =>
        query.productIds.includes(sub)
          ? Promise.resolve(err("UPSTREAM_FAILED"))
          : setup.live.getAvailability(query),
      getPrices: (query) => setup.live.getPrices(query),
    };
    const result = await getOffers({ ...setup.deps, live }, principal, request());
    expect(result.ok ? null : result.error.code).toBe("UPSTREAM_FAILED");
    expect(setup.signer.signed).toEqual([]);
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

  test("a second request within the price cache life reads availability again and the price from the cache", async () => {
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live: quoted(OAT) });

    const first = valueOf(await getOffers(setup.deps, principal, request()));
    setup.clock.set("2026-11-14T10:04:59Z");
    const second = valueOf(await getOffers(setup.deps, principal, request()));

    expect(setup.live.calls.map((call) => call.kind)).toEqual([
      "availability",
      "prices",
      "availability",
    ]);
    expect(second.offers[0]?.claims.unitPrice).toEqual(first.offers[0]?.claims.unitPrice);
    expect(setup.signer.signed).toHaveLength(2);
  });

  test("a second get_offers after the cache life reads availability and the price again", async () => {
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live: quoted(OAT) });

    valueOf(await getOffers(setup.deps, principal, request()));
    setup.clock.set("2026-11-14T10:05:00Z");
    valueOf(await getOffers(setup.deps, principal, request()));

    expect(setup.live.calls.map((call) => call.kind)).toEqual([
      "availability",
      "prices",
      "availability",
      "prices",
    ]);
  });

  test("availability is never served from the cache past the cut-off", async () => {
    const live = quoted(OAT, { cutoffAt: "2026-11-14T10:02:00+00:00" });
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live });

    valueOf(await getOffers(setup.deps, principal, request()));
    setup.clock.set("2026-11-14T10:02:00Z");
    const afterCutoff = valueOf(await getOffers(setup.deps, principal, request()));

    expect(afterCutoff.offers).toEqual([]);
    expect(reasons(afterCutoff.omitted)).toEqual({ [OAT]: "NO_DELIVERY_DATE" });

    // The cached price expired at the cut-off, so each call after it reads availability and the price live.
    const next = live[OAT];
    if (next === undefined) throw new Error("expected live data");
    next.availability = { "*": fakeAvailability(OAT, { cutoffAt: "2026-11-15T10:00:00+00:00" }) };
    const reopened = valueOf(await getOffers(setup.deps, principal, request()));

    expect(reopened.offers).toHaveLength(1);
    expect(setup.live.calls.map((call) => call.kind)).toEqual([
      "availability",
      "prices",
      "availability",
      "prices",
      "availability",
      "prices",
    ]);
  });

  test("a cached price that expires while availability is read is read again", async () => {
    const live = quoted(OAT);
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live });
    valueOf(await getOffers(setup.deps, principal, request()));

    const next = live[OAT];
    if (next === undefined) throw new Error("expected live data");
    next.prices = { "*": fakePrice(OAT, { unitPrice: { net: 20, vatRate: 14, currency: "EUR" } }) };
    setup.clock.set("2026-11-14T10:04:59Z");
    const slow: WholesalerLive = {
      getPrices: (query) => setup.live.getPrices(query),
      getAvailability: async (query) => {
        setup.clock.set("2026-11-14T10:05:01Z");
        return setup.live.getAvailability(query);
      },
    };
    const second = valueOf(await getOffers({ ...setup.deps, live: slow }, principal, request()));

    expect(setup.live.calls.map((call) => call.kind)).toEqual([
      "availability",
      "prices",
      "availability",
      "prices",
    ]);
    expect(second.offers[0]?.claims.unitPrice.net).toBe(20);
  });

  test("a price is not served from the cache after validTo", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT)],
      live: quoted(OAT, {}, { validTo: "2026-11-14T10:01:00+00:00" }),
    });
    valueOf(await getOffers(setup.deps, principal, request()));
    setup.clock.set("2026-11-14T10:01:00Z");
    const after = valueOf(await getOffers(setup.deps, principal, request()));

    expect(setup.live.calls.map((call) => call.kind)).toEqual([
      "availability",
      "prices",
      "availability",
      "prices",
    ]);
    expect(reasons(after.omitted)).toEqual({ [OAT]: "NO_PRICE" });
  });

  test("a cached price is keyed by the delivery date it was read for", async () => {
    const live = quoted(OAT, { availableDate: "2026-11-20" });
    const setup = fakeOffersDeps({ products: [fakeProduct(OAT)], live });

    valueOf(await getOffers(setup.deps, principal, request()));
    const next = live[OAT];
    if (next === undefined) throw new Error("expected live data");
    next.availability = { "*": fakeAvailability(OAT, { availableDate: "2026-11-21" }) };
    valueOf(await getOffers(setup.deps, principal, request()));

    expect(setup.live.calls.map((call) => [call.kind, call.query.requestedDate])).toEqual([
      ["availability", "2026-11-20"],
      ["prices", "2026-11-20"],
      ["availability", "2026-11-20"],
      ["prices", "2026-11-21"],
    ]);
  });

  test("an offer states its gross price per standard unit, or null with no conversion", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT, { perSalesUnit: { value: 2, unit: "LTR" } }), fakeProduct(RYE)],
      live: quotedAll([OAT, RYE]),
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: [line(OAT), line(RYE)] })),
    );

    const claims = Object.fromEntries(result.offers.map((o) => [o.claims.productId, o.claims]));
    expect(claims[OAT]?.pricePerStandardUnit).toEqual({ gross: 5.7, unit: "LTR" });
    expect(claims[RYE]?.pricePerStandardUnit).toBeNull();
  });

  test("the offer states that the deposit is not included when the source has no deposit amount", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT), fakeProduct(RYE)],
      live: {
        ...quoted(OAT, {}, { depositKnown: false }),
        ...quoted(RYE, {}, { deposit: 0.25 }),
      },
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: [line(OAT), line(RYE)] })),
    );

    const claims = Object.fromEntries(result.offers.map((o) => [o.claims.productId, o.claims]));
    expect(claims[OAT]).toMatchObject({ deposits: 0, depositsIncluded: false });
    expect(claims[OAT]?.total.gross).toBe(45.6);
    expect(claims[RYE]).toMatchObject({ deposits: 1, depositsIncluded: true });
    expect(claims[RYE]?.total.gross).toBe(46.6);
  });

  test("an omitted line is not cached", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(OAT)],
      live: quoted(OAT, { amount: 0 }),
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

  test("a line whose totals overflow is omitted INVALID_QUANTITY and the other lines still return", async () => {
    const HUGE = "prod_test_huge";
    const setup = fakeOffersDeps({
      products: [fakeProduct(HUGE), fakeProduct(OAT)],
      live: {
        ...quoted(
          HUGE,
          { amount: 999_999, stock: "unconfirmed" },
          { unitPrice: { net: 1e300, vatRate: 14, currency: "EUR" } },
        ),
        ...quoted(OAT),
      },
    });

    const result = valueOf(
      await getOffers(setup.deps, principal, request({ lines: [line(HUGE, 1e15), line(OAT)] })),
    );

    expect(reasons(result.omitted)).toEqual({ [HUGE]: "INVALID_QUANTITY" });
    expect(result.omitted[0]?.detail).toContain("too large");
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([OAT]);
    expect(setup.signer.signed.map((entry) => entry.claims.productId)).toEqual([OAT]);
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

  test("an offer priced from the cache carries the same claims except iat/exp and a new offerId", async () => {
    const setup = fakeOffersDeps({
      now: "2026-11-14T10:00:00Z",
      products: [fakeProduct(OAT)],
      live: quoted(OAT),
    });

    const first = valueOf(await getOffers(setup.deps, principal, request()));
    setup.clock.set("2026-11-14T10:03:00Z");
    const second = valueOf(await getOffers(setup.deps, principal, request()));

    const firstClaims = first.offers[0]?.claims;
    if (firstClaims === undefined) throw new Error("expected a first offer");
    expect(setup.live.calls.map((call) => call.kind)).toEqual([
      "availability",
      "prices",
      "availability",
    ]);
    // exp is unchanged because it comes from the same validTo and cutoffAt.
    expect(second.offers[0]?.claims).toEqual({
      ...firstClaims,
      offerId: "off_test_2",
      iat: Date.parse("2026-11-14T10:03:00Z") / 1000,
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
