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

  test("an attribute without a data rule is unknown", () => {
    expect(
      matchHard(new Set(["FREE_FROM_GLUTEN"]), [{ attribute: "gluten", is: "free_from" }]),
    ).toEqual({ gluten: "unknown" });
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
