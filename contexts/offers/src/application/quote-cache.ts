import type { PriceQuote } from "@app/contract";
import type { PriceKey, QuoteCache } from "./ports.ts";

const keyOf = (key: PriceKey): string =>
  JSON.stringify([key.customer, key.requestedDate, key.productId]);

export function createQuoteCache(): QuoteCache {
  const entries = new Map<string, { price: PriceQuote; expiresAt: number }>();
  return {
    get(key, now) {
      const id = keyOf(key);
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      if (now.getTime() < entry.expiresAt) return entry.price;
      entries.delete(id);
      return undefined;
    },
    set(key, price, expiresAt) {
      entries.set(keyOf(key), { price, expiresAt: expiresAt.getTime() });
    },
  };
}
