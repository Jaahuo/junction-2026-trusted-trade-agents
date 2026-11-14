import {
  type AvailabilityQuote,
  fixtures,
  type LiveQuery,
  type PriceQuote,
  type WholesalerLive,
} from "@app/contract";
import { ok } from "@app/kernel";

const HOUR_MS = 3_600_000;

export function fixtureWholesaler(now: () => Date = () => new Date()): WholesalerLive {
  const expiry = () => new Date(now().getTime() + HOUR_MS).toISOString();

  const price = (productId: string): PriceQuote => {
    const base =
      productId === fixtures.priceQuote.productId
        ? fixtures.priceQuote
        : {
            productId,
            unitPrice: {
              net: Number((Bun.hash(productId) % 2000n) + 100n) / 100,
              vatRate: 14,
              currency: "EUR" as const,
            },
            deposit: 0,
            comparisonPrice: null,
            validTo: "",
          };
    return { ...base, validTo: expiry() };
  };

  const availability = (productId: string, q: LiveQuery): AvailabilityQuote => {
    const base =
      productId === fixtures.availabilityQuote.productId
        ? fixtures.availabilityQuote
        : {
            productId,
            amount: 500,
            availableDate: null,
            nextDeliveryDate: null,
            cutoffAt: null,
            salesBlocked: false,
            stock: "confirmed" as const,
          };
    return {
      ...base,
      availableDate: q.requestedDate,
      nextDeliveryDate: null,
      cutoffAt: expiry(),
    };
  };

  return {
    getAvailability: async (q) =>
      ok({ quotes: q.productIds.map((id) => availability(id, q)), missing: [] }),
    getPrices: async (q) => ok({ quotes: q.productIds.map(price), missing: [] }),
  };
}
