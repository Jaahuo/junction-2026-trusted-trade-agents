import { err, ok, type Result } from "@app/kernel";
import type {
  AvailabilityQuote,
  OfferClaims,
  OfferLine,
  OffersRequest,
  OffersResult,
  OmitReason,
  PriceQuote,
  Principal,
  ProductFacts,
} from "@app/contract";
import {
  availabilityOmitReason,
  batchIds,
  checkQuantity,
  contradictedAttribute,
  expiredOmitReason,
  lineTotal,
  mergeConstraints,
  offerExpiry,
} from "../domain/offer-rules.ts";
import {
  planOriginalQuantity,
  quantityForShortfall,
  rankSubstitutes,
} from "../domain/partial-stock.ts";
import type { CachedQuote, OffersDeps } from "./ports.ts";

export const PRECHECK_CONCURRENCY = 4;

export interface GetOffersError {
  code: "BAD_REQUEST" | "UPSTREAM_FAILED";
  message: string;
}

type Line = OffersRequest["lines"][number];
type Omitted = OffersResult["omitted"][number];

interface Candidate {
  index: number;
  line: Line;
  product: ProductFacts;
}

interface Dated extends Candidate {
  availability: AvailabilityQuote;
  deliveryDate: string;
  quantity: OfferClaims["quantity"];
  shortfall: OfferClaims["shortfall"];
  replaces: string | null;
  rank: OfferLine["rank"];
  comparison: OfferLine["comparison"];
}

interface Signable extends Dated {
  price: PriceQuote;
  total: { net: number; gross: number };
  deposits: number;
}

const DETAIL: Record<OmitReason, string> = {
  NO_PRICE: "no valid price for the delivery date",
  SALES_BLOCKED: "the product is blocked from sale",
  NO_DELIVERY_DATE: "no delivery date for the requested date",
  UNKNOWN_PRODUCT: "the catalog does not know this product",
  INVALID_QUANTITY: "the quantity is not a positive multiple of the lot size in the sales unit",
  INSUFFICIENT_STOCK: "confirmed stock is below the requested quantity",
  CONSTRAINT_CONTRADICTED: "the product contradicts a hard constraint",
};

export const NO_LIVE_SOURCE_DETAIL =
  "no live price source is configured, so this product cannot be offered or ordered";

const upstream = (message: string): GetOffersError => ({ code: "UPSTREAM_FAILED", message });

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

type ExpiryReason = "NO_DELIVERY_DATE" | "NO_PRICE";

const EXPIRED_DETAIL: Record<ExpiryReason, string> = {
  NO_DELIVERY_DATE: "the order cut-off for the delivery date has passed",
  NO_PRICE: "the price is no longer valid",
};

const jwtSeconds = (ms: number): number => Math.floor(ms / 1000);

// Token exp has second precision, so a deadline within the current second has already passed.
const expiredAt = (price: PriceQuote, quote: AvailabilityQuote, now: Date): ExpiryReason | null =>
  expiredOmitReason(
    price.validTo,
    quote.cutoffAt,
    new Date(jwtSeconds(now.getTime()) * 1000 + 999),
  );

const earlierBound = (price: PriceQuote, quote: AvailabilityQuote): ExpiryReason =>
  quote.cutoffAt !== null && Date.parse(quote.cutoffAt) <= Date.parse(price.validTo)
    ? "NO_DELIVERY_DATE"
    : "NO_PRICE";

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) results[index] = await run(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function getOffers(
  deps: OffersDeps,
  principal: Principal,
  req: OffersRequest,
): Promise<Result<OffersResult, GetOffersError>> {
  if (req.paymentTerms !== principal.paymentTerms) {
    return err({
      code: "BAD_REQUEST",
      message: `paymentTerms must be ${principal.paymentTerms} for this account`,
    });
  }

  const live = deps.live;
  if (live === null) {
    return ok({
      offers: [],
      omitted: req.lines.map((line) => ({
        productId: line.productId,
        reason: "NO_PRICE" as const,
        detail: NO_LIVE_SOURCE_DETAIL,
      })),
    });
  }

  const mandate = await deps.mandates.current();
  if (!mandate.ok) return err(upstream("the current mandate could not be read"));
  const current = mandate.value;
  const constraints = mergeConstraints(
    { hard: req.hard, soft: req.soft },
    current?.standingConstraints ?? null,
  );

  const facts = await deps.catalog.facts({
    productIds: unique(req.lines.map((line) => line.productId)),
    hard: constraints.hard,
  });
  if (!facts.ok) return err(upstream("the catalog facts could not be read"));
  const factsById = new Map(facts.value.products.map((product) => [product.productId, product]));
  const unknown = new Set(facts.value.unknown);

  const omitted = new Map<number, Omitted>();
  const omit = (
    { index, line }: { index: number; line: Line },
    reason: OmitReason,
    detail = DETAIL[reason],
  ): void => {
    omitted.set(index, { productId: line.productId, reason, detail });
  };

  const candidates: Candidate[] = [];
  for (const [index, line] of req.lines.entries()) {
    const product = factsById.get(line.productId);
    if (product === undefined || unknown.has(line.productId)) {
      omit({ index, line }, "UNKNOWN_PRODUCT");
      continue;
    }
    if (checkQuantity(line.quantity, product) !== null) {
      omit(
        { index, line },
        "INVALID_QUANTITY",
        `the quantity must be a positive multiple of ${product.allowedLotSize} ${product.salesUnit}`,
      );
      continue;
    }
    const attribute = contradictedAttribute(product.match, constraints.hard);
    if (attribute !== null) {
      omit(
        { index, line },
        "CONSTRAINT_CONTRADICTED",
        `the product contradicts the hard constraint ${attribute}`,
      );
      continue;
    }
    candidates.push({ index, line, product });
  }

  const customer = principal.customer;
  const cacheKey = (productId: string) => ({ customer, requestedDate: req.deliverBy, productId });
  const lookedUpAt = deps.now();
  const cached = new Map<string, CachedQuote>();
  const availability = new Map<string, AvailabilityQuote>();
  const prices = new Map<string, PriceQuote>();
  const availabilityRead = new Set<string>();
  const priceRead = new Set<string>();

  const loadAvailability = async (ids: readonly string[]): Promise<boolean> => {
    const misses: string[] = [];
    for (const id of unique(ids)) {
      if (availabilityRead.has(id)) continue;
      availabilityRead.add(id);
      const hit = deps.cache.get(cacheKey(id), lookedUpAt);
      if (hit === undefined) misses.push(id);
      else {
        cached.set(id, hit);
        availability.set(id, hit.availability);
        prices.set(id, hit.price);
        priceRead.add(id);
      }
    }
    for (const productIds of batchIds(misses)) {
      const read = await live.getAvailability({
        customer,
        requestedDate: req.deliverBy,
        productIds,
      });
      if (!read.ok) return false;
      for (const quote of read.value.quotes) availability.set(quote.productId, quote);
    }
    return true;
  };

  const loadPrices = async (lines: readonly Dated[]): Promise<boolean> => {
    const byDate = new Map<string, string[]>();
    for (const { product, deliveryDate } of lines) {
      if (priceRead.has(product.productId)) continue;
      priceRead.add(product.productId);
      const ids = byDate.get(deliveryDate) ?? [];
      ids.push(product.productId);
      byDate.set(deliveryDate, ids);
    }
    for (const [requestedDate, ids] of byDate) {
      for (const productIds of batchIds(ids)) {
        const read = await live.getPrices({ customer, requestedDate, productIds });
        if (!read.ok) return false;
        for (const quote of read.value.quotes) prices.set(quote.productId, quote);
      }
    }
    return true;
  };

  if (!(await loadAvailability(candidates.map((candidate) => candidate.product.productId))))
    return err(upstream("availability could not be read"));
  const dated: Dated[] = [];
  for (const candidate of candidates) {
    const quote = availability.get(candidate.product.productId);
    const reason = availabilityOmitReason(quote, 0);
    if (reason !== null || quote === undefined || quote.availableDate === null) {
      omit(candidate, reason ?? "NO_DELIVERY_DATE");
      continue;
    }
    const plan = planOriginalQuantity(candidate.line.quantity, candidate.product, quote);
    if (!plan.ok) {
      omit(candidate, plan.error);
      continue;
    }
    dated.push({
      ...candidate,
      availability: quote,
      deliveryDate: quote.availableDate,
      quantity: plan.value.quantity,
      shortfall: plan.value.shortfall,
      replaces: null,
      rank: null,
      comparison: null,
    });
  }
  if (!(await loadPrices(dated))) return err(upstream("prices could not be read"));

  const substituteOrigins =
    current?.limits.substitutions === "never"
      ? []
      : dated.filter((original) => original.shortfall !== null);
  const substituteIds = unique(
    substituteOrigins.flatMap((original) => original.product.substitutes),
  ).filter((id) => !factsById.has(id) && !unknown.has(id));
  if (substituteIds.length > 0) {
    const read = await deps.catalog.facts({ productIds: substituteIds, hard: constraints.hard });
    if (!read.ok) return err(upstream("the catalog facts could not be read"));
    for (const product of read.value.products) factsById.set(product.productId, product);
    for (const id of read.value.unknown) unknown.add(id);
  }
  const possible: { origin: Dated; product: ProductFacts; quantity: OfferClaims["quantity"] }[] =
    [];
  for (const origin of substituteOrigins) {
    if (origin.shortfall === null) continue;
    for (const id of unique(origin.product.substitutes)) {
      const product = factsById.get(id);
      if (
        id === origin.product.productId ||
        unknown.has(id) ||
        product === undefined ||
        contradictedAttribute(product.match, constraints.hard) !== null
      )
        continue;
      const quantity = quantityForShortfall(origin.shortfall, origin.product, product);
      if (quantity !== null) possible.push({ origin, product, quantity });
    }
  }
  if (!(await loadAvailability(possible.map(({ product }) => product.productId))))
    return err(upstream("availability could not be read"));
  const substituteDated: Dated[] = [];
  for (const { origin, product, quantity } of possible) {
    const quote = availability.get(product.productId);
    if (
      quote === undefined ||
      quote.availableDate === null ||
      availabilityOmitReason(quote, quantity.value) !== null
    )
      continue;
    substituteDated.push({
      ...origin,
      product,
      availability: quote,
      deliveryDate: quote.availableDate,
      quantity,
      shortfall: null,
      replaces: origin.product.productId,
    });
  }
  if (!(await loadPrices(substituteDated))) return err(upstream("prices could not be read"));

  const now = deps.now();
  const signable: Signable[] = [];
  for (const line of dated) {
    const price = prices.get(line.product.productId);
    if (price === undefined) {
      omit(line, "NO_PRICE");
      continue;
    }
    const expired = expiredAt(price, line.availability, now);
    if (expired !== null) {
      omit(line, expired, EXPIRED_DETAIL[expired]);
      continue;
    }
    const { total, deposits } = lineTotal(price.unitPrice, price.deposit, line.quantity.value);
    if (![total.net, total.gross, deposits].every(Number.isFinite)) {
      omit(
        line,
        "INVALID_QUANTITY",
        "the line total is too large to price; order a smaller quantity",
      );
      continue;
    }
    signable.push({ ...line, price, total, deposits });
  }
  const originals = [...signable];
  for (const original of originals) {
    const available: Signable[] = [];
    for (const line of substituteDated) {
      if (line.index !== original.index) continue;
      const price = prices.get(line.product.productId);
      if (price === undefined || expiredAt(price, line.availability, now) !== null) continue;
      const { total, deposits } = lineTotal(price.unitPrice, price.deposit, line.quantity.value);
      if (![total.net, total.gross, deposits].every(Number.isFinite)) continue;
      available.push({ ...line, price, total, deposits });
    }
    const ranked = rankSubstitutes(
      { product: original.product, price: original.price },
      available.map(({ product, price }) => ({ product, price })),
      constraints.soft,
    );
    for (const rank of ranked) {
      const candidate = available.find(({ product }) => product.productId === rank.productId);
      if (candidate !== undefined)
        signable.push({ ...candidate, rank: rank.rank, comparison: rank.comparison });
    }
  }

  const issuer = deps.issuer();
  const signed = await Promise.all(
    signable.map(async (offer) => {
      const { product, price, availability: quote, total, deposits } = offer;
      const claims: Omit<OfferClaims, "iat" | "exp"> = {
        iss: issuer,
        offerId: deps.newOfferId(),
        customer,
        agentId: principal.agentId,
        productId: product.productId,
        quantity: offer.quantity,
        unitPrice: price.unitPrice,
        deposits,
        total,
        deliveryDate: offer.deliveryDate,
        requestedDate: req.deliverBy,
        nextDeliveryDate: quote.nextDeliveryDate,
        stock: quote.stock,
        paymentTerms: principal.paymentTerms,
        cutoffAt: quote.cutoffAt,
        replaces: offer.replaces,
        shortfall: offer.shortfall,
        mandateId: current?.mandateId ?? null,
        mandateVersion: current?.version ?? null,
        constraints,
        product: {
          name: product.name,
          category: product.category,
          perSalesUnit: product.perSalesUnit,
          countryOfOrigin: product.countryOfOrigin,
          deliveryReliability: product.deliveryReliability,
          co2PerKg: product.co2PerKg,
          match: product.match,
        },
      };
      const minted = await deps.signer.sign(claims, offerExpiry(price.validTo, quote.cutoffAt));
      return { offer, minted };
    }),
  );

  const prechecked = await mapLimit(signed, PRECHECK_CONCURRENCY, async (entry) => {
    const precheck = await deps.orders.precheck(entry.minted.token);
    return { ...entry, precheck: precheck.ok ? precheck.value : null };
  });

  // Signing and prechecks take time: drop an offer whose token is already expired.
  const returnedAt = jwtSeconds(deps.now().getTime());
  const survivingOriginals = new Set(
    prechecked
      .filter(({ offer, minted }) => offer.replaces === null && minted.claims.exp > returnedAt)
      .map(({ offer }) => offer.index),
  );
  const offers: OfferLine[] = [];
  for (const { offer, minted, precheck } of prechecked) {
    if (minted.claims.exp <= returnedAt) {
      if (offer.replaces === null) {
        const reason = earlierBound(offer.price, offer.availability);
        omit(offer, reason, EXPIRED_DETAIL[reason]);
      }
      continue;
    }
    if (offer.replaces !== null && !survivingOriginals.has(offer.index)) continue;
    if (!cached.has(offer.product.productId)) {
      deps.cache.set(
        cacheKey(offer.product.productId),
        { availability: offer.availability, price: offer.price },
        new Date(offer.price.validTo),
      );
    }
    offers.push({
      offerId: minted.claims.offerId,
      token: minted.token,
      claims: minted.claims,
      precheck,
      rank: offer.rank,
      comparison: offer.comparison,
    });
  }

  return ok({
    offers,
    omitted: [...omitted.entries()].toSorted(([a], [b]) => a - b).map(([, entry]) => entry),
  });
}
