import { setTimeout as sleepTimer } from "node:timers/promises";

import {
  type AvailabilityQuote,
  AvailabilityQuoteSchema,
  type LiveQuery,
  type PriceQuote,
  PriceQuoteSchema,
  type WholesalerLive,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { env } from "@app/server-kit";
import { z } from "zod";

const DEFAULT_BASE_URL = "https://junction26.valioaimo.fi";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 8_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;

const retryDelay = (header: string | null, now: number): number => {
  if (header === null) return DEFAULT_RETRY_WAIT_MS;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  if (
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/.test(
      value,
    )
  ) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return DEFAULT_RETRY_WAIT_MS;
};
// The challenge API: a Terminal product ships from the supplier's warehouse, and its amount is always
// 999999 because the real amount is unknown. A Stock product's amount is known, however large.
const TERMINAL = "Terminal";
const UNCONFIRMED_AMOUNT = 999_999;
const COMPARISON_UNITS: Readonly<Record<string, "KGM" | "LTR">> = { KG: "KGM", L: "LTR" };

const ScheduleLineSchema = z.object({
  salesBlock: z.boolean(),
  availableAmount: z.number(),
  availableDate: z.string().nullish(),
});
const ProductAvailabilitySchema = z.object({
  productId: z.string(),
  closingTime: z.string().nullish(),
  salesBlock: z.boolean(),
  logisticModel: z.string().nullish(),
  scheduleLines: z.array(ScheduleLineSchema),
});
const AvailabilityResponseSchema = z.object({ products: z.array(z.unknown()) });
type ProductAvailability = z.infer<typeof ProductAvailabilitySchema>;

const PriceItemSchema = z.object({
  productId: z.string(),
  error: z.boolean().nullish(),
  catalogPrice: z
    .object({ value: z.number(), currency: z.string(), validTo: z.string() })
    .nullish(),
  tax: z.object({ taxRate: z.number() }).nullish(),
  comparisonPrice: z.object({ value: z.number() }).nullish(),
  comparisonUnit: z.string().nullish(),
});
const PriceResponseSchema = z.object({ products: z.array(z.unknown()) });
const ProductIdSchema = z.object({ productId: z.string() });
type PriceItem = z.infer<typeof PriceItemSchema>;

const HELSINKI = "Europe/Helsinki";
const helsinkiParts = new Intl.DateTimeFormat("en-US", {
  timeZone: HELSINKI,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

const helsinkiOffsetMinutes = (instantMs: number): number => {
  const parts: Record<string, number> = {};
  for (const part of helsinkiParts.formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts["year"] ?? 0,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
};

const formatOffset = (minutes: number): string => {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
};

/** The Helsinki offset of a local date and time; the +03:00 offset (the earlier instant) wins in a clock overlap. */
const helsinkiOffset = (localMs: number): string => {
  const candidates = [180, 120];
  const match = candidates.find(
    (minutes) => helsinkiOffsetMinutes(localMs - minutes * 60_000) === minutes,
  );
  return formatOffset(match ?? helsinkiOffsetMinutes(localMs - 120 * 60_000));
};

const TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** ISO 8601 with offset, or null. A time with no offset is Europe/Helsinki local time; `dateOnly` is the time of a bare date. */
const toHelsinkiTime = (value: string, dateOnly: string | null): string | null => {
  const match = TIME_PATTERN.exec(value.trim());
  const date = match?.[1];
  if (date === undefined) return null;
  const hm = match?.[2];
  if (hm === undefined && dateOnly === null) return null;
  const time = hm === undefined ? (dateOnly ?? "") : `${hm}:${match?.[3] ?? "00"}`;
  const withSeconds = time.length === 5 ? `${time}:00` : time;
  const offset =
    hm === undefined ? undefined : match?.[4]?.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const local = `${date}T${withSeconds}`;
  const localMs = Date.parse(`${local}Z`);
  if (Number.isNaN(localMs)) return null;
  return `${local}${offset ?? helsinkiOffset(localMs)}`;
};

const addOneDay = (date: string): string => {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000);
  return next.toISOString().slice(0, 10);
};

type Mapped<T> = Result<T, "UPSTREAM_FAILED">;

const unconfirmed = (logisticModel: string | null | undefined, amount: number): boolean =>
  logisticModel === TERMINAL ||
  ((logisticModel === null || logisticModel === undefined) && amount === UNCONFIRMED_AMOUNT);

const mapAvailability = (
  item: ProductAvailability,
): { quote: AvailabilityQuote; later: string | null } | null => {
  const open = item.scheduleLines.find((line) => line.availableAmount > 0 && !line.salesBlock);
  const availableDate = open?.availableDate?.slice(0, 10) ?? null;
  const later =
    availableDate === null
      ? null
      : (item.scheduleLines
          .map((line) => line.availableDate?.slice(0, 10) ?? null)
          .find((date) => date !== null && date > availableDate) ?? null);
  const cutoffAt =
    item.closingTime === null || item.closingTime === undefined
      ? null
      : toHelsinkiTime(item.closingTime, null);
  if (cutoffAt === null && item.closingTime !== null && item.closingTime !== undefined) return null;
  const amount = open?.availableAmount ?? 0;
  const quote = AvailabilityQuoteSchema.safeParse({
    productId: item.productId,
    amount,
    availableDate,
    nextDeliveryDate: later,
    cutoffAt,
    salesBlocked:
      item.salesBlock || (open === undefined && item.scheduleLines.some((line) => line.salesBlock)),
    stock: unconfirmed(item.logisticModel, amount) ? "unconfirmed" : "confirmed",
  });
  return quote.success ? { quote: quote.data, later } : null;
};

const mapPrice = (item: PriceItem): PriceQuote | null => {
  const { catalogPrice, tax } = item;
  if (item.error === true || catalogPrice === null || catalogPrice === undefined) return null;
  if (tax === null || tax === undefined || catalogPrice.currency !== "EUR") return null;
  const validTo = toHelsinkiTime(catalogPrice.validTo, "23:59:59");
  if (validTo === null) return null;
  const unit = COMPARISON_UNITS[item.comparisonUnit ?? ""];
  const quote = PriceQuoteSchema.safeParse({
    productId: item.productId,
    unitPrice: { net: catalogPrice.value, vatRate: tax.taxRate, currency: "EUR" },
    // The price response has no deposit amount, and the product file names deposit materials
    // without a price, so deposits are left out and the offer says so (SPEC-005).
    deposit: 0,
    depositKnown: false,
    comparisonPrice:
      unit === undefined || item.comparisonPrice === null || item.comparisonPrice === undefined
        ? null
        : { value: item.comparisonPrice.value, unit },
    validTo,
  });
  return quote.success ? quote.data : null;
};

export interface MockWholesalerOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const mockWholesaler = (options: MockWholesalerOptions): WholesalerLive => {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const post = async (path: string, body: LiveQuery): Promise<Mapped<unknown>> => {
    const now = options.now ?? Date.now;
    const sleep =
      options.sleep ??
      (async (ms: number, signal: AbortSignal) => {
        await sleepTimer(ms, undefined, { signal });
      });
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const deadline = now() + REQUEST_TIMEOUT_MS;
    let totalWait = 0;
    try {
      const send = options.fetch ?? fetch;
      const payload = JSON.stringify({
        customer: body.customer,
        requestedDate: body.requestedDate,
        products: body.productIds,
      });
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (signal.aborted || now() >= deadline) return err("UPSTREAM_FAILED");
        const response = await send(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "X-API-Key": options.apiKey, "Content-Type": "application/json" },
          body: payload,
          signal,
        });
        if (signal.aborted || now() >= deadline) return err("UPSTREAM_FAILED");
        if (response.ok) {
          const result: unknown = await response.json();
          if (signal.aborted || now() >= deadline) return err("UPSTREAM_FAILED");
          return ok(result);
        }
        if (response.status !== 429 || attempt === MAX_ATTEMPTS - 1) return err("UPSTREAM_FAILED");
        const currentTime = now();
        const delay = retryDelay(response.headers.get("Retry-After"), currentTime);
        if (totalWait + delay > MAX_RETRY_WAIT_MS || currentTime + delay >= deadline) {
          return err("UPSTREAM_FAILED");
        }
        await response.body?.cancel();
        if (signal.aborted || now() + delay >= deadline) return err("UPSTREAM_FAILED");
        totalWait += delay;
        await sleep(delay, signal);
      }
      return err("UPSTREAM_FAILED");
    } catch {
      return err("UPSTREAM_FAILED");
    }
  };

  const readAvailability = async (
    q: LiveQuery,
  ): Promise<
    Mapped<{ items: Map<string, { quote: AvailabilityQuote; later: string | null }> }>
  > => {
    const raw = await post("/api/availability", q);
    if (!raw.ok) return raw;
    const parsed = AvailabilityResponseSchema.safeParse(raw.value);
    if (!parsed.success) return err("UPSTREAM_FAILED");
    const requested = new Set(q.productIds);
    const items = new Map<string, { quote: AvailabilityQuote; later: string | null }>();
    for (const entry of parsed.data.products) {
      const id = ProductIdSchema.safeParse(entry);
      if (!id.success) continue;
      const { productId } = id.data;
      if (!requested.has(productId) || items.has(productId)) continue;
      const product = ProductAvailabilitySchema.safeParse(entry);
      const mapped = product.success ? mapAvailability(product.data) : null;
      if (mapped === null) continue;
      items.set(productId, mapped);
    }
    return ok({ items });
  };

  return {
    async getAvailability(q) {
      const first = await readAvailability(q);
      if (!first.ok) return first;
      const quotes = new Map<string, AvailabilityQuote>();
      const needLater = new Map<string, string[]>();
      for (const [productId, { quote, later }] of first.value.items) {
        quotes.set(productId, quote);
        if (later === null && quote.availableDate !== null) {
          const date = addOneDay(quote.availableDate);
          needLater.set(date, [...(needLater.get(date) ?? []), productId]);
        }
      }
      await Promise.all(
        [...needLater].map(async ([requestedDate, productIds]) => {
          const further = await readAvailability({ ...q, requestedDate, productIds });
          if (!further.ok) return;
          for (const productId of productIds) {
            const base = quotes.get(productId);
            const next = further.value.items.get(productId)?.quote.availableDate ?? null;
            if (base !== undefined && next !== null && next > (base.availableDate ?? "")) {
              quotes.set(productId, { ...base, nextDeliveryDate: next });
            }
          }
        }),
      );
      return ok({
        quotes: [...quotes.values()],
        missing: q.productIds.filter((id) => !quotes.has(id)),
      });
    },

    async getPrices(q) {
      const raw = await post("/api/price", q);
      if (!raw.ok) return raw;
      const parsed = PriceResponseSchema.safeParse(raw.value);
      if (!parsed.success) return err("UPSTREAM_FAILED");
      const requested = new Set(q.productIds);
      const quotes = new Map<string, PriceQuote>();
      const seen = new Set<string>();
      for (const entry of parsed.data.products) {
        const id = ProductIdSchema.safeParse(entry);
        if (!id.success) continue;
        const { productId } = id.data;
        if (!requested.has(productId) || seen.has(productId)) continue;
        seen.add(productId);
        const item = PriceItemSchema.safeParse(entry);
        const quote = item.success ? mapPrice(item.data) : null;
        if (quote !== null) quotes.set(productId, quote);
      }
      return ok({
        quotes: [...quotes.values()],
        missing: q.productIds.filter((id) => !quotes.has(id)),
      });
    },
  };
};

export const mockWholesalerFromEnv = (
  read: (name: string) => string | undefined = env,
): WholesalerLive | null => {
  const apiKey = read("VALIO_AIMO_API_KEY");
  if (apiKey === undefined) return null;
  return mockWholesaler({ baseUrl: read("VALIO_AIMO_BASE_URL") ?? DEFAULT_BASE_URL, apiKey });
};
