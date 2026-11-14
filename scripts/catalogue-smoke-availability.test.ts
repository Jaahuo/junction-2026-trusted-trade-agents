import { expect, test } from "bun:test";
import { availabilityFixture } from "./catalogue-smoke-availability.ts";

test("image smoke exposes fictional stock on the requested date without leaking recorded IDs", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const result = availabilityFixture(["fictional-oats", "464201", "unknown"], "2026-11-20", now);
  expect(result.products).toEqual([
    {
      productId: "fictional-oats",
      closingTime: "2026-11-15T12:00:00.000Z",
      salesBlock: false,
      logisticModel: "Stock",
      scheduleLines: [
        {
          salesBlock: false,
          availableAmount: 9999999999,
          availableDate: "2026-11-20",
          salesUnit: "ST",
        },
      ],
    },
  ]);
  availabilityFixture(["fictional-oats"], "2026-12-01", now);
  expect(result.products[0]?.scheduleLines?.[0]?.availableDate).toBe("2026-11-20");
});
