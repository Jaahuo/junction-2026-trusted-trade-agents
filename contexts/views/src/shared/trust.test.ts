import { expect, test } from "bun:test";
import { allergenText, type LineAllergen, sortAllergens } from "./trust.ts";

const chip = (allergen: string, type: LineAllergen["type"], status: LineAllergen["status"]) => ({
  allergen,
  type,
  status,
});

test("chips order: broken rule, trace risk, free from, then information, A to Z in each", () => {
  const sorted = sortAllergens([
    chip("milk", "contains", "default"),
    chip("lactose", "free_from", "default"),
    chip("sesame", "may_contain", "warning"),
    chip("gluten", "may_contain", "default"),
    chip("egg", "contains", "error"),
  ]);
  expect(sorted.map(allergenText)).toEqual([
    "Contains egg",
    "May contain sesame",
    "Free from lactose",
    "May contain gluten",
    "Contains milk",
  ]);
});
