import { expect, test } from "bun:test";
import { fixtureWholesaler } from "./wholesaler-fixture.ts";

const S1 = "464201";
const S2 = "464306";
const UNKNOWN = "000000";
const RECORDING_DAY = new Date("2026-11-14T16:30:00Z");

const query = (requestedDate: string, productIds = [S1, S2, UNKNOWN]) => ({
  customer: "cust_test",
  requestedDate,
  productIds,
});

test("on the recording day the fixture returns the recorded availability and prices and reports unknown ids as missing", async () => {
  const live = fixtureWholesaler({ now: () => RECORDING_DAY });
  const availability = await live.getAvailability(query("2026-11-16"));
  const prices = await live.getPrices(query("2026-11-16"));
  const quote = {
    amount: 9_999_999_999,
    availableDate: "2026-11-16",
    nextDeliveryDate: null,
    cutoffAt: "2026-11-15T17:00:00+02:00",
    salesBlocked: false,
    stock: "confirmed" as const,
  };
  expect(availability).toEqual({
    ok: true,
    value: {
      quotes: [
        { productId: S1, ...quote },
        { productId: S2, ...quote },
      ],
      missing: [UNKNOWN],
    },
  });
  expect(prices).toEqual({
    ok: true,
    value: {
      quotes: [
        {
          productId: S1,
          unitPrice: { net: 1.56, vatRate: 13.5, currency: "EUR" },
          deposit: 0,
          depositKnown: false,
          comparisonPrice: { value: 1.56, unit: "LTR" },
          validTo: "9999-12-31T00:00:00+02:00",
        },
        {
          productId: S2,
          unitPrice: { net: 1.01, vatRate: 13.5, currency: "EUR" },
          deposit: 0,
          depositKnown: false,
          comparisonPrice: { value: 1.01, unit: "LTR" },
          validTo: "2026-12-31T00:00:00+02:00",
        },
      ],
      missing: [UNKNOWN],
    },
  });
});

test("on a later day the fixture moves every date by the same days, keeps the open-ended price and invents no later delivery", async () => {
  const live = fixtureWholesaler({ now: () => new Date("2026-11-20T10:00:00Z") });
  const availability = await live.getAvailability(query("2026-11-22", [S1]));
  const prices = await live.getPrices(query("2026-11-22", [S1, S2]));
  expect(availability.ok && availability.value.quotes).toEqual([
    {
      productId: S1,
      amount: 9_999_999_999,
      availableDate: "2026-11-22",
      nextDeliveryDate: null,
      cutoffAt: "2026-11-21T17:00:00+02:00",
      salesBlocked: false,
      stock: "confirmed",
    },
  ]);
  expect(prices.ok && prices.value.quotes.map((q) => [q.productId, q.validTo])).toEqual([
    [S1, "9999-12-31T00:00:00+02:00"],
    [S2, "2027-01-06T00:00:00+02:00"],
  ]);
});

test("a moved cutoff is read as Helsinki local time, so it keeps its clock time across a change to summer time", async () => {
  const live = fixtureWholesaler({ now: () => new Date("2027-04-01T09:00:00Z") });
  const availability = await live.getAvailability(query("2027-04-03", [S2]));
  expect(availability.ok && availability.value.quotes[0]?.cutoffAt).toBe(
    "2027-04-02T17:00:00+03:00",
  );
});

test("a date before the recorded request gets the first recorded answer", async () => {
  const live = fixtureWholesaler({ now: () => RECORDING_DAY });
  const availability = await live.getAvailability(query("2026-11-14", [S1]));
  expect(availability.ok && availability.value.quotes[0]?.availableDate).toBe("2026-11-16");
});
