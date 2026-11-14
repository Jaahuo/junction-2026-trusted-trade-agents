// Text of the offer comparison placeholder, in each view language.

export const OFFERS = {
  en: {
    summary: (offers: number, omitted: number) =>
      `${offers} offer${offers === 1 ? "" : "s"}, ${omitted} product${omitted === 1 ? "" : "s"} omitted`,
  },
  fi: {
    summary: (offers: number, omitted: number) =>
      `${offers} ${offers === 1 ? "tarjous" : "tarjousta"}, ${omitted} ${omitted === 1 ? "tuote" : "tuotetta"} jätetty pois`,
  },
};
