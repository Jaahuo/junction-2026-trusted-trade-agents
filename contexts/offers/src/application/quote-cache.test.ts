import { describe, expect, test } from "bun:test";
import { fakePrice } from "./fakes.ts";
import { createQuoteCache } from "./quote-cache.ts";

const key = { customer: "cust_test", requestedDate: "2026-11-20", productId: "prod_test_oat" };
const price = fakePrice(key.productId);
const expiresAt = new Date("2026-11-14T12:00:00Z");

describe("createQuoteCache", () => {
  test("serves a stored price before it expires", () => {
    const cache = createQuoteCache();
    cache.set(key, price, expiresAt);
    expect(cache.get(key, new Date("2026-11-14T11:59:59Z"))).toBe(price);
  });

  test("does not serve a price at or after its expiry", () => {
    const cache = createQuoteCache();
    cache.set(key, price, expiresAt);
    expect(cache.get(key, expiresAt)).toBeUndefined();
    cache.set(key, price, expiresAt);
    expect(cache.get(key, new Date("2026-11-14T12:00:01Z"))).toBeUndefined();
  });

  test("keys entries by customer, pricing date and productId", () => {
    const cache = createQuoteCache();
    const now = new Date("2026-11-14T10:00:00Z");
    cache.set(key, price, expiresAt);
    expect(cache.get({ ...key, customer: "cust_other" }, now)).toBeUndefined();
    expect(cache.get({ ...key, requestedDate: "2026-11-21" }, now)).toBeUndefined();
    expect(cache.get({ ...key, productId: "prod_test_other" }, now)).toBeUndefined();
    expect(cache.get({ ...key }, now)).toBe(price);
  });

  test("a later set overwrites the whole entry", () => {
    const cache = createQuoteCache();
    const fresh = fakePrice(key.productId, { deposit: 0.1 });
    cache.set(key, price, expiresAt);
    cache.set(key, fresh, new Date("2026-11-14T13:00:00Z"));
    expect(cache.get(key, new Date("2026-11-14T12:30:00Z"))).toBe(fresh);
  });
});
