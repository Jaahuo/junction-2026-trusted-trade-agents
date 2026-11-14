import { expect, test } from "bun:test";
import { preferred } from "./constraints.ts";
import { setLang } from "./locale.ts";

test("a preferred constraint reads in English, with region names and words", () => {
  expect(preferred("countryOfOrigin", "fi")).toBe("Country of origin: Finland");
  expect(preferred("packagingMaterial", "returnableGlass")).toBe(
    "Packaging material: Returnable glass",
  );
});

test("a preferred constraint reads in Finnish; an unknown value keeps its words", () => {
  setLang("fi");
  try {
    expect(preferred("countryOfOrigin", "fi")).toBe("Alkuperämaa: Suomi");
    expect(preferred("packagingMaterial", "returnableGlass")).toBe(
      "Pakkausmateriaali: palautettava lasi",
    );
    expect(preferred("packaging", "reusable")).toBe("Pakkaus: uudelleenkäytettävä");
    expect(preferred("brand", "valio")).toBe("Brand: Valio");
  } finally {
    setLang("en");
  }
});
