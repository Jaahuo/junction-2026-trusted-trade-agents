import { expect, test } from "bun:test";
import type { WholesalerLive } from "@app/contract";
import { err } from "@app/kernel";
import { selectLive } from "./adapters.ts";

const mock: WholesalerLive = {
  getAvailability: async () => err("UPSTREAM_FAILED"),
  getPrices: async () => err("UPSTREAM_FAILED"),
};

const pick = (mode: string | undefined, adapter: WholesalerLive | null) => {
  const warnings: string[] = [];
  const live = selectLive(mode, adapter, (message) => warnings.push(message));
  return { live, warnings };
};

const isFixture = async (live: WholesalerLive): Promise<boolean> => {
  const read = await live.getAvailability({
    customer: "cust_test",
    requestedDate: "2026-11-20",
    productIds: ["prod_test_any"],
  });
  return read.ok && read.value.quotes.length === 1;
};

test("selectLive picks the mock for mode mock with an adapter, else the fixture; mock without an adapter, json and an unknown mode warn once; unset and fixture do not warn", async () => {
  const chosen = pick("mock", mock);
  expect(chosen.live).toBe(mock);
  expect(chosen.warnings).toEqual([]);

  for (const mode of [undefined, "fixture"]) {
    const { live, warnings } = pick(mode, mock);
    expect({ mode, fixture: await isFixture(live), warnings }).toEqual({
      mode,
      fixture: true,
      warnings: [],
    });
  }

  for (const [mode, adapter] of [
    ["mock", null],
    ["json", mock],
    ["sandbox", mock],
  ] as const) {
    const { live, warnings } = pick(mode, adapter);
    expect({ mode, fixture: await isFixture(live), warnings: warnings.length }).toEqual({
      mode,
      fixture: true,
      warnings: 1,
    });
  }
  expect(pick("sandbox", mock).warnings[0]).toContain("sandbox");
});
