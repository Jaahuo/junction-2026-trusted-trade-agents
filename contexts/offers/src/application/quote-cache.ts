import type { CachedQuote, QuoteCache } from "./ports.ts";

type Key = { customer: string; requestedDate: string; productId: string };

const keyOf = (key: Key): string =>
  JSON.stringify([key.customer, key.requestedDate, key.productId]);

export function createQuoteCache(): QuoteCache {
  const entries = new Map<string, { quote: CachedQuote; expiresAt: number }>();
  return {
    get(key, now) {
      const id = keyOf(key);
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      if (now.getTime() < entry.expiresAt) return entry.quote;
      entries.delete(id);
      return undefined;
    },
    set(key, quote, expiresAt) {
      entries.set(keyOf(key), { quote, expiresAt: expiresAt.getTime() });
    },
  };
}
