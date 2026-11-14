import { describe, expect, test } from "bun:test";
import {
  fixtures,
  type AvailabilityQuote,
  type Mandate,
  type OffersRequest,
  type PriceQuote,
} from "@app/contract";
import type { Result } from "@app/kernel";
import {
  fakeAvailability,
  fakeOffersDeps,
  fakePrice,
  fakeProduct,
  type FakeLiveData,
} from "./fakes.ts";
import { getOffers } from "./get-offers.ts";

const ORIGINAL = "prod_test_partial_original";
const principal = fixtures.account;
const lactose = { attribute: "lactose", is: "free_from" } as const;
const litre = { value: 1, unit: "LTR" };

const request = (value = 1000, patch: Partial<OffersRequest> = {}): OffersRequest => ({
  lines: [{ productId: ORIGINAL, quantity: { value, unit: "CT" } }],
  deliverBy: "2026-11-20",
  paymentTerms: principal.paymentTerms,
  hard: [],
  soft: [],
  ...patch,
});

const quoted = (
  id: string,
  availability: Partial<AvailabilityQuote> = {},
  price: Partial<PriceQuote> = {},
): FakeLiveData => ({
  [id]: {
    availability: { "*": fakeAvailability(id, availability) },
    prices: { "*": fakePrice(id, price) },
  },
});

const valueOf = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const mandate = (patch: Partial<Mandate> = {}): Mandate => ({
  ...fixtures.storedMandate.mandate,
  limits: { ...fixtures.storedMandate.mandate.limits, substitutions: "ask" },
  ...patch,
});

describe("partial stock and substitutes", () => {
  test("an advanced substitute is priced on its selected date without treating earlier stock as confirmed", async () => {
    const sub = "prod_test_advanced_substitute";
    const setup = fakeOffersDeps({
      mandate: mandate(),
      products: [
        fakeProduct(ORIGINAL, { perSalesUnit: litre, substitutes: [sub] }),
        fakeProduct(sub, { perSalesUnit: litre }),
      ],
      live: {
        ...quoted(ORIGINAL, { amount: 600 }),
        [sub]: {
          availability: {
            "*": fakeAvailability(sub, {
              availableDate: "2026-11-19",
              nextDeliveryDate: "2026-11-20",
              cutoffAt: "2026-11-14T10:00:00Z",
              amount: 0,
            }),
          },
          prices: {
            "2026-11-20": fakePrice(sub, { unitPrice: { net: 7, vatRate: 14, currency: "EUR" } }),
          },
        },
      },
    });
    const result = valueOf(await getOffers(setup.deps, principal, request()));
    const alternative = result.offers.find((offer) => offer.claims.productId === sub);
    expect(alternative?.claims).toMatchObject({
      replaces: ORIGINAL,
      quantity: { value: 400, unit: "CT" },
      deliveryDate: "2026-11-20",
      nextDeliveryDate: null,
      cutoffAt: "2026-11-15T12:00:00.000+02:00",
      stock: "unconfirmed",
      unitPrice: { net: 7 },
    });
    expect(
      setup.live.calls.some(
        (call) =>
          call.kind === "prices" &&
          call.query.requestedDate === "2026-11-20" &&
          call.query.productIds.includes(sub),
      ),
    ).toBe(true);
  });

  test("offers the available amount and signs a standard-unit shortfall", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(ORIGINAL, { perSalesUnit: litre })],
      live: quoted(ORIGINAL, { amount: 600 }),
    });
    const result = valueOf(await getOffers(setup.deps, principal, request()));

    expect(result.omitted).toEqual([]);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.claims).toMatchObject({
      productId: ORIGINAL,
      quantity: { value: 600, unit: "CT" },
      shortfall: { value: 400, unit: "LTR" },
      replaces: null,
    });
    expect(setup.signer.signed[0]?.claims).toMatchObject({
      quantity: { value: 600, unit: "CT" },
      shortfall: { value: 400, unit: "LTR" },
    });
  });

  test("floors stock to the product's lot and omits stock below one lot", async () => {
    const below = "prod_test_below_lot";
    const setup = fakeOffersDeps({
      products: [
        fakeProduct(ORIGINAL, { perSalesUnit: litre, allowedLotSize: 10 }),
        fakeProduct(below, { perSalesUnit: litre, allowedLotSize: 10 }),
      ],
      live: { ...quoted(ORIGINAL, { amount: 605 }), ...quoted(below, { amount: 9 }) },
    });
    const result = valueOf(
      await getOffers(
        setup.deps,
        principal,
        request(1000, {
          lines: [
            { productId: ORIGINAL, quantity: { value: 1000, unit: "CT" } },
            { productId: below, quantity: { value: 1000, unit: "CT" } },
          ],
        }),
      ),
    );

    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.claims).toMatchObject({
      productId: ORIGINAL,
      quantity: { value: 600, unit: "CT" },
      shortfall: { value: 400, unit: "LTR" },
    });
    expect(result.omitted).toEqual([
      expect.objectContaining({ productId: below, reason: "INSUFFICIENT_STOCK" }),
    ]);
  });

  test("reports a shortfall in sales units when conversion is unavailable", async () => {
    const setup = fakeOffersDeps({
      products: [fakeProduct(ORIGINAL, { perSalesUnit: null })],
      live: quoted(ORIGINAL, { amount: 600 }),
    });
    const result = valueOf(await getOffers(setup.deps, principal, request()));
    expect(result.offers[0]?.claims.shortfall).toEqual({ value: 400, unit: "CT" });
  });

  test("substitutes cover the shortage in their own lots, retain merged constraints and sign replaces", async () => {
    const good = "prod_test_partial_good";
    const contradicted = "prod_test_partial_contradicted";
    const tooShort = "prod_test_partial_too_short";
    const mismatch = "prod_test_partial_mismatch";
    const asked = { attribute: "organic", prefer: "yes" };
    const standing = { attribute: "countryOfOrigin", prefer: "fi" };
    const current = mandate({ standingConstraints: { hard: [lactose], soft: [standing] } });
    const setup = fakeOffersDeps({
      mandate: current,
      products: [
        fakeProduct(ORIGINAL, {
          perSalesUnit: litre,
          match: { lactose: "confirmed" },
          substitutes: [good, contradicted, tooShort, mismatch],
        }),
        fakeProduct(good, {
          perSalesUnit: { value: 3, unit: "LTR" },
          allowedLotSize: 10,
          match: { lactose: "confirmed" },
        }),
        fakeProduct(contradicted, { perSalesUnit: litre, match: { lactose: "contradicted" } }),
        fakeProduct(tooShort, { perSalesUnit: litre, match: { lactose: "confirmed" } }),
        fakeProduct(mismatch, {
          perSalesUnit: { value: 1, unit: "KGM" },
          match: { lactose: "confirmed" },
        }),
      ],
      live: {
        ...quoted(ORIGINAL, { amount: 600 }),
        ...quoted(good, { amount: 1000 }),
        ...quoted(contradicted, { amount: 1000 }),
        ...quoted(tooShort, { amount: 399 }),
        ...quoted(mismatch, { amount: 1000 }),
      },
    });
    const result = valueOf(
      await getOffers(setup.deps, principal, request(1000, { soft: [asked] })),
    );
    const alternatives = result.offers.filter((offer) => offer.claims.replaces === ORIGINAL);

    expect(alternatives).toHaveLength(1);
    expect(alternatives[0]?.claims).toMatchObject({
      productId: good,
      replaces: ORIGINAL,
      quantity: { value: 140, unit: "CT" },
      constraints: { hard: [lactose], soft: [asked, standing] },
      mandateId: current.mandateId,
      mandateVersion: current.version,
    });
    expect(alternatives[0]?.comparison?.replaces).toBe(ORIGINAL);
    expect(
      setup.signer.signed.find((entry) => entry.claims.productId === good)?.claims,
    ).toMatchObject({
      replaces: ORIGINAL,
      quantity: { value: 140, unit: "CT" },
      constraints: { hard: [lactose], soft: [asked, standing] },
    });
    expect(result.offers.map((offer) => offer.claims.productId)).not.toContain(contradicted);
    expect(result.offers.map((offer) => offer.claims.productId)).not.toContain(tooShort);
    expect(result.offers.map((offer) => offer.claims.productId)).not.toContain(mismatch);
    expect(
      setup.catalog.requests
        .filter((req) => req.productIds.includes(good))
        .every((req) =>
          req.hard.some(
            (constraint) => constraint.attribute === "lactose" && constraint.is === "free_from",
          ),
        ),
    ).toBe(true);
  });

  test("never policy avoids looking up or offering substitutes", async () => {
    const substitute = "prod_test_partial_never";
    const current = mandate();
    const setup = fakeOffersDeps({
      mandate: { ...current, limits: { ...current.limits, substitutions: "never" } },
      products: [
        fakeProduct(ORIGINAL, { perSalesUnit: litre, substitutes: [substitute] }),
        fakeProduct(substitute, { perSalesUnit: litre }),
      ],
      live: { ...quoted(ORIGINAL, { amount: 600 }), ...quoted(substitute, { amount: 1000 }) },
    });
    const result = valueOf(await getOffers(setup.deps, principal, request()));
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([ORIGINAL]);
    expect(setup.catalog.requests.flatMap((req) => req.productIds)).not.toContain(substitute);
    expect(setup.live.calls.flatMap((call) => call.query.productIds)).not.toContain(substitute);
  });

  test("a never rule leaves out that substitute and keeps the others", async () => {
    const blocked = "prod_test_partial_blocked";
    const kept = "prod_test_partial_kept";
    const current = mandate();
    const setup = fakeOffersDeps({
      mandate: {
        ...current,
        limits: {
          ...current.limits,
          substitutionRules: [
            {
              replaces: ORIGINAL,
              productId: blocked,
              policy: "never",
              decidedAt: "2026-11-14T10:00:00+00:00",
            },
          ],
        },
      },
      products: [
        fakeProduct(ORIGINAL, { perSalesUnit: litre, substitutes: [blocked, kept] }),
        fakeProduct(blocked, { perSalesUnit: litre }),
        fakeProduct(kept, { perSalesUnit: litre }),
      ],
      live: {
        ...quoted(ORIGINAL, { amount: 600 }),
        ...quoted(blocked, { amount: 1000 }),
        ...quoted(kept, { amount: 1000 }),
      },
    });
    const result = valueOf(await getOffers(setup.deps, principal, request()));
    expect(result.offers.map((offer) => offer.claims.productId)).toEqual([ORIGINAL, kept]);
    expect(setup.catalog.requests.flatMap((req) => req.productIds)).not.toContain(blocked);
  });

  test("ranks by soft match, price per standard unit, reliability and CO2, retaining at most three", async () => {
    const soft = "prod_test_rank_soft";
    const reliable = "prod_test_rank_reliable";
    const clean = "prod_test_rank_clean";
    const dirty = "prod_test_rank_dirty";
    const expensive = "prod_test_rank_expensive";
    const ids = [dirty, expensive, clean, reliable, soft];
    const setup = fakeOffersDeps({
      mandate: mandate(),
      products: [
        fakeProduct(ORIGINAL, { perSalesUnit: litre, substitutes: ids }),
        fakeProduct(soft, {
          perSalesUnit: litre,
          countryOfOrigin: "fi",
          deliveryReliability: 0.5,
          co2PerKg: 2,
        }),
        fakeProduct(reliable, {
          perSalesUnit: litre,
          countryOfOrigin: "se",
          deliveryReliability: 0.9,
          co2PerKg: 1,
        }),
        fakeProduct(clean, {
          perSalesUnit: litre,
          countryOfOrigin: "se",
          deliveryReliability: 0.8,
          co2PerKg: 0.2,
        }),
        fakeProduct(dirty, {
          perSalesUnit: litre,
          countryOfOrigin: "se",
          deliveryReliability: 0.8,
          co2PerKg: 0.9,
        }),
        fakeProduct(expensive, {
          perSalesUnit: litre,
          countryOfOrigin: "se",
          deliveryReliability: 1,
          co2PerKg: 0.1,
        }),
      ],
      live: {
        ...quoted(ORIGINAL, { amount: 600 }),
        ...quoted(
          soft,
          { amount: 1000 },
          {
            unitPrice: { net: 5, vatRate: 14, currency: "EUR" },
            comparisonPrice: { value: 5, unit: "LTR" },
          },
        ),
        ...quoted(
          reliable,
          { amount: 1000 },
          {
            unitPrice: { net: 1, vatRate: 14, currency: "EUR" },
            comparisonPrice: { value: 1, unit: "LTR" },
          },
        ),
        ...quoted(
          clean,
          { amount: 1000 },
          {
            unitPrice: { net: 1, vatRate: 14, currency: "EUR" },
            comparisonPrice: { value: 1, unit: "LTR" },
          },
        ),
        ...quoted(
          dirty,
          { amount: 1000 },
          {
            unitPrice: { net: 1, vatRate: 14, currency: "EUR" },
            comparisonPrice: { value: 1, unit: "LTR" },
          },
        ),
        ...quoted(
          expensive,
          { amount: 1000 },
          {
            unitPrice: { net: 2, vatRate: 14, currency: "EUR" },
            comparisonPrice: { value: 2, unit: "LTR" },
          },
        ),
      },
    });
    const result = valueOf(
      await getOffers(
        setup.deps,
        principal,
        request(1000, {
          soft: [{ attribute: "countryOfOrigin", prefer: "fi" }],
        }),
      ),
    );
    const alternatives = result.offers.filter((offer) => offer.claims.replaces === ORIGINAL);
    expect(alternatives.map((offer) => offer.claims.productId)).toEqual([soft, reliable, clean]);
    expect(alternatives.map((offer) => offer.rank)).toEqual(["best", "better", "good"]);
  });
});
