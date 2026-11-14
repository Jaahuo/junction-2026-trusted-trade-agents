import { intlLocale, pick } from "./locale.ts";
import { FI_ALLERGENS } from "./trust.ts";

// Constraint labels, shared by search results and agent settings:
// "Gluten free", "Vegan", "Country of origin: Finland", "Pakkausmateriaali: palautettava lasi".

/** "packagingMaterial", "invented_drinks" → "Packaging material", "Invented drinks". */
const words = (key: string) => {
  const spaced = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** "fi" → "Finland"; a code with no region name falls back to words. */
const country = (code: string) => {
  try {
    const regions = new Intl.DisplayNames([intlLocale()], { type: "region", fallback: "none" });
    return regions.of(code.toUpperCase()) ?? words(code);
  } catch {
    return words(code);
  }
};

/** Names of the attributes and values the server sends in English; others read as words. */
const NAMES: Record<
  "en" | "fi",
  { attributes: Record<string, string>; values: Record<string, string> }
> = {
  en: { attributes: {}, values: {} },
  fi: {
    attributes: {
      countryOfOrigin: "Alkuperämaa",
      category: "Tuoteryhmä",
      packaging: "Pakkaus",
      packagingMaterial: "Pakkausmateriaali",
    },
    values: {
      returnableGlass: "palautettava lasi",
      reusable: "uudelleenkäytettävä",
      recyclable: "kierrätettävä",
      glass: "lasi",
      plastic: "muovi",
      cardboard: "kartonki",
    },
  },
};

const attributeName = (attribute: string) =>
  pick(NAMES).attributes[attribute] ??
  (attribute === "countryOfOrigin" ? "Country of origin" : words(attribute));

/** "Country of origin: Finland": a preferred constraint as the approver reads it. */
export const preferred = (attribute: string, prefer: string) =>
  `${attributeName(attribute)}: ${
    attribute === "countryOfOrigin"
      ? country(prefer)
      : (pick(NAMES).values[prefer] ?? words(prefer))
  }`;

const REQUIRED: Record<
  "en" | "fi",
  { labels: Record<string, string>; free: (attribute: string) => string }
> = {
  en: { labels: { vegan: "Vegan" }, free: (attribute) => `${attributeName(attribute)} free` },
  fi: {
    labels: { lactose: "Laktoositon", vegan: "Vegaaninen" },
    free: (attribute) => {
      const name = FI_ALLERGENS[attribute];
      return name === undefined ? `${attributeName(attribute)}: ei sisällä` : `Ei ${name}`;
    },
  },
};

/** "Gluten free", "Vegan": a required (hard) constraint as the approver reads it (SPEC-004). */
export const required = (attribute: string) => {
  const text = pick(REQUIRED);
  return text.labels[attribute] ?? text.free(attribute);
};
