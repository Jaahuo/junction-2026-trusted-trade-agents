import { expect, test } from "bun:test";
import type { WholesalerLive } from "@app/contract";
import { err } from "@app/kernel";
import { selectLive } from "./adapters.ts";

const mock: WholesalerLive = {
  getAvailability: async () => err("UPSTREAM_FAILED"),
  getPrices: async () => err("UPSTREAM_FAILED"),
};
const fixture: WholesalerLive = { ...mock };

const pick = (mode: string | undefined, adapter: WholesalerLive | null) => {
  const warnings: string[] = [];
  const live = selectLive(mode, { mock: adapter, fixture: () => fixture }, (message) =>
    warnings.push(message),
  );
  return { live, warnings };
};

test("selectLive picks the mock for mode mock with an adapter without a warning", () => {
  expect(pick("mock", mock)).toEqual({ live: mock, warnings: [] });
});

test("selectLive picks the fixture for mode fixture and says once that its prices are recorded, not live", () => {
  for (const adapter of [mock, null]) {
    const { live, warnings } = pick("fixture", adapter);
    expect(live).toBe(fixture);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("WHOLESALER_LIVE=fixture");
    expect(warnings[0]).toContain("not live");
    expect(warnings[0]).not.toContain("NO_PRICE");
  }
});

test("selectLive gives no live source and one NO_PRICE warning when the mode is unset, mock without an adapter, json or unknown", () => {
  for (const [mode, adapter] of [
    [undefined, mock],
    ["mock", null],
    ["json", mock],
    ["sandbox", mock],
  ] as const) {
    const { live, warnings } = pick(mode, adapter);
    expect({ mode, live, warnings: warnings.length }).toEqual({ mode, live: null, warnings: 1 });
    expect(warnings[0]).toContain("NO_PRICE");
  }
  expect(pick("sandbox", mock).warnings[0]).toContain("sandbox");
  expect(pick(undefined, mock).warnings[0]).toContain("WHOLESALER_LIVE is not set");
});
