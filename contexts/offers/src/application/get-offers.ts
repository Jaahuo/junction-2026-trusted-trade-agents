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
}

interface Signable extends Dated {
  price: PriceQuote;
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

const upstream = (message: string): GetOffersError => ({ code: "UPSTREAM_FAILED", message });

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

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
  const cacheKey = (productId: string) => ({
    customer,
    requestedDate: req.deliverBy,
    productId,
  });
  const lookedUpAt = deps.now();
  const cached = new Map<string, CachedQuote>();
  for (const productId of unique(candidates.map((c) => c.line.productId))) {
    const hit = deps.cache.get(cacheKey(productId), lookedUpAt);
    if (hit !== undefined) cached.set(productId, hit);
  }
  const misses = unique(candidates.map((c) => c.line.productId)).filter((id) => !cached.has(id));

  const availability = new Map<string, AvailabilityQuote>();
  for (const productIds of batchIds(misses)) {
    const read = await deps.live.getAvailability({
      customer,
      requestedDate: req.deliverBy,
      productIds,
    });
    if (!read.ok) return err(upstream("availability could not be read"));
    for (const quote of read.value.quotes) availability.set(quote.productId, quote);
  }
  for (const [productId, hit] of cached) availability.set(productId, hit.availability);

  const dated: Dated[] = [];
  for (const candidate of candidates) {
    const quote = availability.get(candidate.line.productId);
    if (quote === undefined) {
      omit(candidate, "NO_DELIVERY_DATE");
      continue;
    }
    const reason = availabilityOmitReason(quote, candidate.line.quantity.value);
    const deliveryDate = quote.availableDate;
    if (reason !== null || deliveryDate === null) {
      omit(candidate, reason ?? "NO_DELIVERY_DATE");
      continue;
    }
    dated.push({ ...candidate, availability: quote, deliveryDate });
  }

  const missesByDate = new Map<string, string[]>();
  for (const { line, deliveryDate } of dated) {
    if (cached.has(line.productId)) continue;
    missesByDate.set(deliveryDate, [...(missesByDate.get(deliveryDate) ?? []), line.productId]);
  }
  const prices = new Map<string, PriceQuote>();
  for (const [requestedDate, ids] of missesByDate) {
    for (const productIds of batchIds(ids)) {
      const read = await deps.live.getPrices({ customer, requestedDate, productIds });
      if (!read.ok) return err(upstream("prices could not be read"));
      for (const quote of read.value.quotes) prices.set(quote.productId, quote);
    }
  }
  for (const [productId, hit] of cached) prices.set(productId, hit.price);

  // Re-read: a quote may expire during the upstream calls, and the signer stamps iat later.
  const now = deps.now();
  const signable: Signable[] = [];
  for (const line of dated) {
    const price = prices.get(line.line.productId);
    if (price === undefined) {
      omit(line, "NO_PRICE");
      continue;
    }
    const expired = expiredOmitReason(price.validTo, line.availability.cutoffAt, now);
    if (expired === "NO_DELIVERY_DATE") {
      omit(line, expired, "the order cut-off for the delivery date has passed");
      continue;
    }
    if (expired === "NO_PRICE") {
      omit(line, expired, "the price is no longer valid");
      continue;
    }
    signable.push({ ...line, price });
  }

  const issuer = deps.issuer();
  const signed = await Promise.all(
    signable.map(async (offer) => {
      const { line, product, price, availability: quote } = offer;
      const exp = offerExpiry(price.validTo, quote.cutoffAt);
      const { total, deposits } = lineTotal(price.unitPrice, price.deposit, line.quantity.value);
      const claims: Omit<OfferClaims, "iat" | "exp"> = {
        iss: issuer,
        offerId: deps.newOfferId(),
        customer,
        agentId: principal.agentId,
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: price.unitPrice,
        deposits,
        total,
        deliveryDate: offer.deliveryDate,
        requestedDate: req.deliverBy,
        nextDeliveryDate: quote.nextDeliveryDate,
        stock: quote.stock,
        paymentTerms: principal.paymentTerms,
        cutoffAt: quote.cutoffAt,
        replaces: null,
        shortfall: null,
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
      const minted = await deps.signer.sign(claims, exp);
      if (!cached.has(line.productId)) {
        deps.cache.set(cacheKey(line.productId), { availability: quote, price }, exp);
      }
      return minted;
    }),
  );

  const offers: OfferLine[] = await mapLimit(signed, PRECHECK_CONCURRENCY, async (minted) => {
    const precheck = await deps.orders.precheck(minted.token);
    return {
      offerId: minted.claims.offerId,
      token: minted.token,
      claims: minted.claims,
      precheck: precheck.ok ? precheck.value : null,
      rank: null,
      comparison: null,
    };
  });

  return ok({
    offers,
    omitted: [...omitted.entries()].toSorted(([a], [b]) => a - b).map(([, entry]) => entry),
  });
}
