// Text of the offer comparison placeholder, in each view language.

export const OFFERS = {
  en: {
    summary: (offers: number, omitted: number) => `${offers} offers, ${omitted} products omitted`,
  },
  fi: {
    summary: (offers: number, omitted: number) =>
      `${offers} tarjousta, ${omitted} tuotetta jätetty pois`,
  },
};
