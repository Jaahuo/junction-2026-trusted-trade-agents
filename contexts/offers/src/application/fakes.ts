import { err, ok, type Result } from "@app/kernel";
import {
  fixtures,
  type AvailabilityQuote,
  type FactsRequest,
  type LiveQuery,
  type Mandate,
  type OfferClaims,
  type Precheck,
  type PriceQuote,
  type ProductFacts,
  type WholesalerLive,
} from "@app/contract";
import type { CatalogFacts, CurrentMandate, OfferSigner, OffersDeps, Prechecker } from "./ports.ts";
import { createQuoteCache } from "./quote-cache.ts";

// Invented products only (team rules R-23).

const FAKE_NOW = "2026-11-14T10:00:00Z";
export const FAKE_ISSUER = "http://offers.test";

export const fakeProduct = (
  productId: string,
  patch: Partial<ProductFacts> = {},
): ProductFacts => ({
  productId,
  gtin: null,
  name: `Test product ${productId}`,
  category: "test_category",
  salesUnit: "CT",
  allowedLotSize: 1,
  perSalesUnit: null,
  countryOfOrigin: "fi",
  deliveryReliability: 0.95,
  co2PerKg: 0.5,
  match: {},
  substitutes: [],
  ...patch,
});

export const fakeAvailability = (
  productId: string,
  patch: Partial<AvailabilityQuote> = {},
): AvailabilityQuote => ({
  productId,
  amount: 100,
  availableDate: "2026-11-19",
  nextDeliveryDate: null,
  cutoffAt: "2026-11-18T10:00:00+02:00",
  salesBlocked: false,
  stock: "confirmed",
  ...patch,
});

export const fakePrice = (productId: string, patch: Partial<PriceQuote> = {}): PriceQuote => ({
  productId,
  unitPrice: { net: 10, vatRate: 14, currency: "EUR" },
  deposit: 0,
  comparisonPrice: null,
  validTo: "2026-11-18T21:59:59+00:00",
  ...patch,
});

type LiveKind = "availability" | "prices";
interface LiveCall {
  kind: LiveKind;
  query: LiveQuery;
}

/** Quotes per product, keyed by date; `"*"` answers any date. */
export type FakeLiveData = Record<
  string,
  { availability?: Record<string, AvailabilityQuote>; prices?: Record<string, PriceQuote> }
>;

interface FakeWholesaler extends WholesalerLive {
  readonly calls: LiveCall[];
  /** Without `kind`, both calls fail. */
  failWith(on: boolean, kind?: LiveKind): void;
}

function fakeWholesaler(data: FakeLiveData): FakeWholesaler {
  const calls: LiveCall[] = [];
  const failing = new Set<LiveKind>();
  const answer = <T>(
    kind: LiveKind,
    query: LiveQuery,
    pick: (id: string) => Record<string, T> | undefined,
  ): Result<{ quotes: T[]; missing: string[] }, "UPSTREAM_FAILED"> => {
    calls.push({ kind, query });
    if (failing.has(kind)) return err("UPSTREAM_FAILED");
    const quotes: T[] = [];
    const missing: string[] = [];
    for (const id of query.productIds) {
      const byDate = pick(id);
      const quote = byDate?.[query.requestedDate] ?? byDate?.["*"];
      if (quote === undefined) missing.push(id);
      else quotes.push(quote);
    }
    return ok({ quotes, missing });
  };
  return {
    calls,
    failWith(on, kind) {
      for (const each of kind === undefined ? (["availability", "prices"] as const) : [kind]) {
        if (on) failing.add(each);
        else failing.delete(each);
      }
    },
    getAvailability: async (query) => answer("availability", query, (id) => data[id]?.availability),
    getPrices: async (query) => answer("prices", query, (id) => data[id]?.prices),
  };
}

interface FakeCatalog extends CatalogFacts {
  readonly requests: FactsRequest[];
  fail(on: boolean): void;
}

function fakeCatalog(products: readonly ProductFacts[]): FakeCatalog {
  const requests: FactsRequest[] = [];
  let failing = false;
  return {
    requests,
    fail(on) {
      failing = on;
    },
    async facts(req) {
      requests.push(req);
      if (failing) return err("UPSTREAM_FAILED");
      const known = products.filter((product) => req.productIds.includes(product.productId));
      const ids = new Set(known.map((product) => product.productId));
      return ok({ products: known, unknown: req.productIds.filter((id) => !ids.has(id)) });
    },
  };
}

interface FakeMandates extends CurrentMandate {
  fail(on: boolean): void;
}

function fakeMandates(mandate: Mandate | null): FakeMandates {
  let failing = false;
  return {
    fail(on) {
      failing = on;
    },
    current: async () => (failing ? err("UPSTREAM_FAILED") : ok(mandate)),
  };
}

interface FakePrechecker extends Prechecker {
  readonly calls: string[];
  readonly maxInFlight: number;
  /** An error answer stands for orders answering 501 or being unreachable. */
  answerWith(answer: Result<Precheck, "UNAVAILABLE">): void;
}

function fakePrechecker(
  initial: Result<Precheck, "UNAVAILABLE"> = ok(fixtures.precheck),
): FakePrechecker {
  const calls: string[] = [];
  let answer = initial;
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    answerWith(next) {
      answer = next;
    },
    async precheck(token) {
      calls.push(token);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return answer;
    },
  };
}

interface FakeSigner extends OfferSigner {
  readonly signed: { claims: Omit<OfferClaims, "iat" | "exp">; exp: Date }[];
}

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

function fakeSigner(now: () => Date): FakeSigner {
  const signed: FakeSigner["signed"] = [];
  return {
    signed,
    async sign(claims, exp) {
      signed.push({ claims, exp });
      return {
        token: `fake.${claims.offerId}`,
        claims: { ...claims, iat: seconds(now()), exp: seconds(exp) },
      };
    },
    jwks: async () => ({ keys: [{ kty: "EC", crv: "P-256", kid: "fake-key" }] }),
  };
}

interface FakeClock {
  readonly now: () => Date;
  set(iso: string): void;
}

function fakeClock(start = FAKE_NOW): FakeClock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set(iso) {
      current = new Date(iso);
    },
  };
}

export interface FakeOffers {
  deps: OffersDeps;
  live: FakeWholesaler;
  catalog: FakeCatalog;
  mandates: FakeMandates;
  orders: FakePrechecker;
  signer: FakeSigner;
  clock: FakeClock;
}

export function fakeOffersDeps(
  options: {
    live?: FakeLiveData;
    products?: readonly ProductFacts[];
    mandate?: Mandate | null;
    now?: string;
  } = {},
): FakeOffers {
  const clock = fakeClock(options.now);
  const live = fakeWholesaler(options.live ?? {});
  const catalog = fakeCatalog(options.products ?? []);
  const mandates = fakeMandates(options.mandate ?? null);
  const orders = fakePrechecker();
  const signer = fakeSigner(clock.now);
  let sequence = 0;
  return {
    deps: {
      live,
      catalog,
      mandates,
      orders,
      signer,
      cache: createQuoteCache(),
      issuer: () => FAKE_ISSUER,
      now: clock.now,
      newOfferId: () => {
        sequence += 1;
        return `off_test_${sequence}`;
      },
    },
    live,
    catalog,
    mandates,
    orders,
    signer,
    clock,
  };
}
