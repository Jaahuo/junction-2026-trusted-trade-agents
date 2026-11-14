import { describe, expect, test } from "bun:test";
import { AvailabilityQuoteSchema, fixtures, type LiveQuery, PriceQuoteSchema } from "@app/contract";
import { fixtureWholesaler } from "./wholesaler-fixture.ts";

const clock = new Date("2026-11-14T10:00:00.000Z");
const hourLater = "2026-11-14T11:00:00.000Z";
const contractId = fixtures.priceQuote.productId;
const query = (productIds: string[]): LiveQuery => ({
  customer: "cust_test",
  requestedDate: "2026-11-20",
  productIds,
});

const wholesaler = fixtureWholesaler(() => clock);

async function quotes(productIds: string[]) {
  const [p, a] = await Promise.all([
    wholesaler.getPrices(query(productIds)),
    wholesaler.getAvailability(query(productIds)),
  ]);
  if (!p.ok || !a.ok) throw new Error("fixture wholesaler failed");
  return { prices: p.value, availability: a.value };
}

describe("fixtureWholesaler", () => {
  test("any product id gets the same synthetic price twice", async () => {
    const first = await quotes(["prod_test_alpha", "prod_test_beta"]);
    const second = await quotes(["prod_test_alpha", "prod_test_beta"]);
    expect(second.prices.quotes).toEqual(first.prices.quotes);
    expect(first.prices.missing).toEqual([]);
    expect(first.prices.quotes[0]?.unitPrice.net).not.toBe(first.prices.quotes[1]?.unitPrice.net);
    const ids = ["prod_test_a", "prod_test_b", "prod_test_c", "prod_test_d", "prod_test_e"];
    const many = await quotes(ids);
    for (const q of many.prices.quotes) {
      expect(Math.round(q.unitPrice.net * 100) / 100).toBe(q.unitPrice.net);
    }
  });

  test("validTo and cutoffAt are one hour after the injected clock for every product, the contract fixture product included", async () => {
    const { prices, availability } = await quotes(["prod_test_alpha", contractId]);
    expect(prices.quotes.map((q) => q.validTo)).toEqual([hourLater, hourLater]);
    for (const q of availability.quotes) {
      expect(q.cutoffAt).toBe(hourLater);
      expect(q.availableDate).toBe("2026-11-20");
      expect(q.nextDeliveryDate).toBeNull();
    }
  });

  test("the contract fixture product keeps its price, amount and stock", async () => {
    const { prices, availability } = await quotes([contractId]);
    const p = prices.quotes[0];
    const a = availability.quotes[0];
    expect(p?.unitPrice).toEqual(fixtures.priceQuote.unitPrice);
    expect(p?.deposit).toBe(fixtures.priceQuote.deposit);
    expect(p?.comparisonPrice).toEqual(fixtures.priceQuote.comparisonPrice);
    expect(a?.amount).toBe(fixtures.availabilityQuote.amount);
    expect(a?.stock).toBe(fixtures.availabilityQuote.stock);
  });

  test("every fixture quote parses with PriceQuoteSchema and AvailabilityQuoteSchema", async () => {
    const { prices, availability } = await quotes(["prod_test_alpha", contractId]);
    for (const q of prices.quotes) expect(PriceQuoteSchema.safeParse(q).success).toBe(true);
    for (const q of availability.quotes) {
      expect(AvailabilityQuoteSchema.safeParse(q).success).toBe(true);
    }
    const synthetic = prices.quotes[0];
    expect(synthetic?.unitPrice.vatRate).toBe(14);
    expect(synthetic?.deposit).toBe(0);
    expect(availability.quotes[0]?.amount).toBe(500);
  });
});
