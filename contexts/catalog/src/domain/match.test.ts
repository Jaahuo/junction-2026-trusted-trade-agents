import { describe, expect, test } from "bun:test";
import { isContradicted, matchHard, mergeConstraints } from "./match.ts";

const lactoseFree = [{ attribute: "lactose", is: "free_from" }] as const;

describe("hard constraint match", () => {
  test("FREE_FROM_LACTOSE is confirmed, LOW_LACTOSE is contradicted for free_from, no claim is unknown", () => {
    expect(matchHard(new Set(["FREE_FROM_LACTOSE", "LOW_FAT"]), lactoseFree)).toEqual({
      lactose: "confirmed",
    });
    expect(matchHard(new Set(["LOW_LACTOSE"]), lactoseFree)).toEqual({ lactose: "contradicted" });
    expect(matchHard(new Set(), lactoseFree)).toEqual({ lactose: "unknown" });
  });

  const eggFree = [{ attribute: "egg", is: "free_from" }] as const;

  test("CONTAINS or MAY_CONTAIN of the allergen is contradicted", () => {
    expect(matchHard(new Set(["CONTAINS:AE"]), eggFree)).toEqual({ egg: "contradicted" });
    expect(matchHard(new Set(["MAY_CONTAIN:AE"]), eggFree)).toEqual({ egg: "contradicted" });
  });

  test("FREE_FROM or the free-from claim is confirmed; no data or data on other allergens is unknown", () => {
    expect(matchHard(new Set(["FREE_FROM:AE"]), eggFree)).toEqual({ egg: "confirmed" });
    expect(matchHard(new Set(["FREE_FROM_EGGS"]), eggFree)).toEqual({ egg: "confirmed" });
    expect(matchHard(new Set(), eggFree)).toEqual({ egg: "unknown" });
    expect(matchHard(new Set(["FREE_FROM:AW", "UNDECLARED:AE"]), eggFree)).toEqual({
      egg: "unknown",
    });
  });

  test("a contradicting allergen fact wins over a free-from claim", () => {
    expect(matchHard(new Set(["FREE_FROM_LACTOSE", "MAY_CONTAIN:ML"]), lactoseFree)).toEqual({
      lactose: "contradicted",
    });
    expect(matchHard(new Set(["FREE_FROM:AE", "CONTAINS:AE"]), eggFree)).toEqual({
      egg: "contradicted",
    });
  });

  test("a claim-only attribute is confirmed by its claim and contradicted by its low claim", () => {
    const fatFree = [{ attribute: "fat", is: "free_from" }] as const;
    expect(matchHard(new Set(["FREE_FROM_FAT"]), fatFree)).toEqual({ fat: "confirmed" });
    expect(matchHard(new Set(["LOW_FAT"]), fatFree)).toEqual({ fat: "contradicted" });
  });

  test("vegan is confirmed by the VEGAN claim and contradicted by an animal allergen, not by traces", () => {
    const vegan = [{ attribute: "vegan", is: "yes" }] as const;
    expect(matchHard(new Set(["VEGAN", "MAY_CONTAIN:AM"]), vegan)).toEqual({ vegan: "confirmed" });
    expect(matchHard(new Set(["VEGAN", "CONTAINS:AE"]), vegan)).toEqual({
      vegan: "contradicted",
    });
    expect(matchHard(new Set(["CONTAINS:AW"]), vegan)).toEqual({ vegan: "unknown" });
  });

  test("only a contradicted match counts as contradicted", () => {
    expect(isContradicted({ lactose: "contradicted" })).toBe(true);
    expect(isContradicted({ lactose: "unknown" })).toBe(false);
    expect(isContradicted({})).toBe(false);
  });
});

describe("constraint merge", () => {
  const request = {
    hard: [{ attribute: "lactose" as const, is: "free_from" as const }],
    soft: [{ attribute: "countryOfOrigin", prefer: "se" }],
  };

  test("merges standing constraints without duplicates", () => {
    expect(
      mergeConstraints(request, {
        hard: [{ attribute: "lactose", is: "free_from" }],
        soft: [{ attribute: "countryOfOrigin", prefer: "fi" }],
      }),
    ).toEqual({
      hard: [{ attribute: "lactose", is: "free_from" }],
      soft: [
        { attribute: "countryOfOrigin", prefer: "se" },
        { attribute: "countryOfOrigin", prefer: "fi" },
      ],
    });
  });

  test("no standing constraints keeps the request", () => {
    expect(mergeConstraints(request, null)).toEqual(request);
  });

  test("dedupes by attribute and value, whatever the key order or the case of a soft preference", () => {
    const reordered = { is: "free_from", attribute: "lactose" } as const;
    expect(
      mergeConstraints(
        {
          hard: [{ attribute: "lactose", is: "free_from" }],
          soft: [{ attribute: "countryOfOrigin", prefer: "FI" }],
        },
        { hard: [reordered], soft: [{ attribute: "countryOfOrigin", prefer: "fi" }] },
      ),
    ).toEqual({
      hard: [{ attribute: "lactose", is: "free_from" }],
      soft: [{ attribute: "countryOfOrigin", prefer: "FI" }],
    });
  });
});
