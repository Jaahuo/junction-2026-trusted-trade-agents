import { expect, test } from "bun:test";
import { setLang } from "./locale.ts";
import { allergenText, brokenRule, type LineAllergen, sortAllergens } from "./trust.ts";

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

test("Finnish chips name the allergen in Finnish; an unknown one keeps the server's word", () => {
  setLang("fi");
  try {
    expect(allergenText(chip("egg", "contains", "error"))).toBe("Sisältää kananmunaa");
    expect(allergenText(chip("Lactose", "free_from", "default"))).toBe("Ei sisällä laktoosia");
    expect(allergenText(chip("sesame", "may_contain", "warning"))).toBe(
      "Voi sisältää seesaminsiemeniä",
    );
    expect(brokenRule(chip("milk", "contains", "error"))).toBe("Rikkoo sääntöäsi: ei maitoa");
    expect(allergenText(chip("kiwi", "contains", "default"))).toBe("Sisältää kiwi");
  } finally {
    setLang("en");
  }
});
