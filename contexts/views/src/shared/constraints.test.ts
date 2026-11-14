import { expect, test } from "bun:test";
import { preferred, required } from "./constraints.ts";
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

test("a required constraint reads in Finnish with the allergen's own name when there is one", () => {
  setLang("fi");
  try {
    expect(required("gluten")).toBe("Ei gluteenia");
    expect(required("lactose")).toBe("Laktoositon");
    expect(required("vegan")).toBe("Vegaaninen");
    expect(required("pineNut")).toBe("Pine nut: ei sisällä");
  } finally {
    setLang("en");
  }
});
