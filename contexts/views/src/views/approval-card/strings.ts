// Text of the shared parts and the approval view, in each view language.

export const PARTS = {
  en: {
    // Units in words, including the Valio Aimo sales units of real offers (KI, SK, PAK …).
    units: {
      CT: "packs",
      PCE: "pcs",
      ST: "pcs",
      KI: "cases",
      CS: "cases",
      PAK: "packs",
      BAG: "bags",
      RAS: "boxes",
      PRK: "tubs",
      BOT: "bottles",
      SK: "sacks",
      KLE: "packages",
      KRT: "cartons",
      KAN: "canisters",
      PAL: "pallets",
      NIP: "bundles",
      DSP: "displays",
      DZ: "dozen",
    } as Record<string, string>,
    today: "Today",
    vat: { net: "excl. VAT", gross: "incl. VAT" },
  },
  fi: {
    // The short forms of a Finnish wholesale order.
    units: {
      CT: "pkt",
      PCE: "kpl",
      ST: "kpl",
      KI: "ltk",
      CS: "ltk",
      PAK: "pkt",
      BAG: "pss",
      RAS: "rs",
      PRK: "prk",
      BOT: "plo",
      SK: "säkki",
      KLE: "kolli",
      KRT: "krt",
      KAN: "kanisteri",
      PAL: "lava",
      NIP: "nippu",
      DSP: "esillepano",
      DZ: "tusina",
    } as Record<string, string>,
    today: "Tänään",
    vat: { net: "alv 0 %", gross: "sis. ALV" },
  },
};

export const VIEW = {
  en: {
    approvals: "Approvals",
    brandApprovals: (name: string) => `${name} approvals`,
    order: "Order",
    orderFor: (day: string) => `Order for ${day}`,
    agentUpdating: "The agent is updating this order",
    checkingOrder: "Checking your order…",
    loadingApprovals: "Loading approvals…",
    verifying: "Verifying the signed offers and checking them against your limits.",
    cantShowTitle: "This approval can't be shown here",
    cantShowBody: "Open it on the approval page to review and decide.",
    cantShowRetry: "Try again in a moment.",
    openApprovalPage: "Open approval page",
    tryAgain: "Try again",
    opensNewTab: "Opens in a new tab",
    noneWaiting: "No orders wait for approval",
    newRequests: "New requests from the agent show up here.",
    waiting: (n: number) => `${n} order${n === 1 ? "" : "s"} wait for approval`,
    products: "Products",
    decideBy: "Decide by",
    review: "Review",
    allApprovals: "← All approvals",
    notSent: "The message was not sent.",
    failures: {
      OFFER_EXPIRED: "An offer in this order has expired. Ask the agent for new offers.",
      STALE_OFFER: "The mandate changed after the offers were made. Ask the agent for new offers.",
      CONFLICT: "This order was already decided or changed. Reload to see it.",
      NOT_FOUND: "This order no longer exists.",
      UPSTREAM_FAILED: "The decision could not be checked right now. Try again in a moment.",
      NOT_IMPLEMENTED:
        "Changing amounts is not available yet. Approve the order as it is, or ask the agent.",
    } as Record<string, string>,
    notSaved: "The decision was not saved. Try again.",
    // What the card says for the approver after a decision; the agent reads it.
    decided: {
      placed: (name: string, brand: string) => `${name} approved. It is placed with ${brand}.`,
      awaitingPayment: (name: string, brand: string) =>
        `${name} approved. It goes to ${brand} when the payment is confirmed.`,
      notPlaced: (name: string, reasons: string) => `${name} was not placed: ${reasons}`,
      alternatives: (name: string) =>
        `${name} rejected. Look for alternatives and send me a new order to approve.`,
      stop: (name: string) =>
        `${name} rejected. Order nothing for it, and do not ask again unless I ask for a new order.`,
    },
  },
  fi: {
    approvals: "Hyväksynnät",
    brandApprovals: (name: string) => `${name} -hyväksynnät`,
    order: "Tilaus",
    orderFor: (day: string) => `Tilaus, toimitus ${day}`,
    agentUpdating: "Agentti päivittää tätä tilausta",
    checkingOrder: "Tarkistetaan tilaustasi…",
    loadingApprovals: "Ladataan hyväksyntöjä…",
    verifying: "Tarkistetaan allekirjoitetut tarjoukset ja verrataan niitä rajoihisi.",
    cantShowTitle: "Hyväksyntää ei voi näyttää tässä",
    cantShowBody: "Avaa se hyväksyntäsivulla, niin voit tarkistaa ja päättää.",
    cantShowRetry: "Yritä hetken päästä uudelleen.",
    openApprovalPage: "Avaa hyväksyntäsivu",
    tryAgain: "Yritä uudelleen",
    opensNewTab: "Avautuu uuteen välilehteen",
    noneWaiting: "Ei hyväksyntää odottavia tilauksia",
    newRequests: "Agentin uudet pyynnöt näkyvät tässä.",
    waiting: (n: number) =>
      n === 1 ? "1 tilaus odottaa hyväksyntää" : `${n} tilausta odottaa hyväksyntää`,
    products: "Tuotteet",
    decideBy: "Päätä viimeistään",
    review: "Tarkista",
    allApprovals: "← Kaikki hyväksynnät",
    notSent: "Viestiä ei lähetetty.",
    failures: {
      OFFER_EXPIRED: "Tilauksen tarjous on vanhentunut. Pyydä agentilta uudet tarjoukset.",
      STALE_OFFER: "Valtuutus muuttui tarjousten jälkeen. Pyydä agentilta uudet tarjoukset.",
      CONFLICT: "Tilauksesta on jo päätetty tai sitä on muutettu. Lataa uudelleen nähdäksesi sen.",
      NOT_FOUND: "Tilausta ei enää ole.",
      UPSTREAM_FAILED: "Päätöstä ei voitu tarkistaa juuri nyt. Yritä hetken päästä uudelleen.",
      NOT_IMPLEMENTED:
        "Määrien muuttaminen ei ole vielä mahdollista. Hyväksy tilaus sellaisenaan tai kysy agentilta.",
    } as Record<string, string>,
    notSaved: "Päätöstä ei tallennettu. Yritä uudelleen.",
    decided: {
      placed: (name: string, brand: string) =>
        `Hyväksyin: ${name}. Tilaus on lähetetty toimittajalle ${brand}.`,
      awaitingPayment: (name: string, brand: string) =>
        `Hyväksyin: ${name}. Se lähtee toimittajalle ${brand}, kun maksu on vahvistettu.`,
      notPlaced: (name: string, reasons: string) => `${name} ei mennyt läpi: ${reasons}`,
      alternatives: (name: string) =>
        `Hylkäsin: ${name}. Etsi vaihtoehtoja ja lähetä minulle uusi tilaus hyväksyttäväksi.`,
      stop: (name: string) =>
        `Hylkäsin: ${name}. Älä tilaa sitä äläkä kysy uudelleen, ellen pyydä uutta tilausta.`,
    },
  },
};
