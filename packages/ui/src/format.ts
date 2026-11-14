export const ORDER_STATUS_LABELS = {
  pending_approval: "Needs your approval",
  awaiting_payment: "Awaiting payment",
  placed: "Placed",
  rejected: "Rejected",
  declined: "Declined",
} as const;

export const ORDER_ACTIONS = {
  approve: "Approve order",
  rejectStop: "Reject and stop",
  rejectAlternatives: "Reject, allow alternatives",
} as const;

export const ORDER_OUTCOMES = {
  placed: "The order is placed at the offered price and delivery date.",
  stop: "The agent stops and tells the approver.",
  alternatives: "The agent may look for alternatives.",
} as const;

export const ORDER_ACTORS = { agent: "Agent", server: "Server", approver: "Approver" } as const;
export const ORDER_TERMS = { limit: "Order limit", paymentOnOrder: "Pay on order" } as const;

/** A language of the wording and formats. English is the default everywhere. */
export type FormatLang = "en" | "fi";

const ORDER_WORDING_EN = {
  statuses: ORDER_STATUS_LABELS,
  actions: ORDER_ACTIONS,
  outcomes: ORDER_OUTCOMES,
  actors: ORDER_ACTORS,
  terms: ORDER_TERMS,
};
type OrderWording = {
  readonly [G in keyof typeof ORDER_WORDING_EN]: {
    readonly [K in keyof (typeof ORDER_WORDING_EN)[G]]: string;
  };
};

/** The order wording in each language, with the same keys as the English exports. */
export const ORDER_WORDING: Record<FormatLang, OrderWording> = {
  en: ORDER_WORDING_EN,
  fi: {
    statuses: {
      pending_approval: "Tarvitsee hyväksyntäsi",
      awaiting_payment: "Odottaa maksua",
      placed: "Tilattu",
      rejected: "Hylätty",
      declined: "Hylätty hyväksynnässä",
    },
    actions: {
      approve: "Hyväksy tilaus",
      rejectStop: "Hylkää ja lopeta",
      rejectAlternatives: "Hylkää, salli vaihtoehdot",
    },
    outcomes: {
      placed: "Tilaus on tehty tarjouksen hinnalla ja toimituspäivällä.",
      stop: "Agentti lopettaa ja kertoo hyväksyjälle.",
      alternatives: "Agentti saa etsiä vaihtoehtoja.",
    },
    actors: { agent: "Agentti", server: "Palvelin", approver: "Hyväksyjä" },
    terms: { limit: "Tilausraja", paymentOnOrder: "Maksu tilattaessa" },
  },
};

const INTL: Record<FormatLang, string> = { en: "en-FI", fi: "fi-FI" };

const UNAVAILABLE = {
  en: {
    amount: "Amount unavailable",
    basis: { net: "net", gross: "gross" },
    date: "Delivery date unavailable",
    time: "Time unavailable",
    quantity: "Quantity unavailable",
    unit: "unit unknown",
    order: "Order number unavailable",
  },
  fi: {
    amount: "Summa ei saatavilla",
    basis: { net: "veroton", gross: "verollinen" },
    date: "Toimituspäivä ei saatavilla",
    time: "Aika ei saatavilla",
    quantity: "Määrä ei saatavilla",
    unit: "yksikkö tuntematon",
    order: "Tilausnumero ei saatavilla",
  },
} as const satisfies Record<FormatLang, unknown>;

const deliveryDateFormatter = (lang: FormatLang) =>
  new Intl.DateTimeFormat(INTL[lang], {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const timestampFormatter = (lang: FormatLang) =>
  new Intl.DateTimeFormat(INTL[lang], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });
const quantityFormatter = (lang: FormatLang) =>
  new Intl.NumberFormat(INTL[lang], { maximumFractionDigits: 20 });

export function formatMoney(
  value: number,
  currency: string,
  basis: "net" | "gross",
  lang: FormatLang = "en",
): string {
  const text = UNAVAILABLE[lang];
  const label = text.basis[basis];
  if (!Number.isFinite(value) || !/^[A-Za-z]{3}$/.test(currency))
    return `${text.amount} (${label})`;
  try {
    return `${new Intl.NumberFormat(INTL[lang], { style: "currency", currency: currency.toUpperCase() }).format(value)} (${label})`;
  } catch {
    return `${text.amount} (${label})`;
  }
}

function validDateParts(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (days[month - 1] ?? 0);
}

export function formatDeliveryDate(value: string, lang: FormatLang = "en"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || !validDateParts(Number(match[1]), Number(match[2]), Number(match[3])))
    return UNAVAILABLE[lang].date;
  const date = new Date(`${value}T00:00:00Z`);
  return deliveryDateFormatter(lang).format(date);
}

export function formatTimestamp(value: string, lang: FormatLang = "en"): string {
  const unavailable = UNAVAILABLE[lang].time;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (
    !match ||
    !validDateParts(Number(match[1]), Number(match[2]), Number(match[3])) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    return unavailable;
  const zone = match[7];
  if (!zone || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)))
    return unavailable;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return unavailable;
  return `${timestampFormatter(lang).format(date)} UTC`;
}

const units: Readonly<Record<string, readonly [string, string]>> = {
  CT: ["pack", "packs"],
  PCE: ["piece", "pieces"],
  LTR: ["litre", "litres"],
  KGM: ["kilogram", "kilograms"],
  KG: ["kilogram", "kilograms"],
  ST: ["piece", "pieces"],
  KI: ["case", "cases"],
  CS: ["case", "cases"],
  BAG: ["bag", "bags"],
  BOT: ["bottle", "bottles"],
  DSP: ["display", "displays"],
  DZ: ["dozen", "dozen"],
  KRT: ["carton", "cartons"],
  NIP: ["bundle", "bundles"],
  PAK: ["package", "packages"],
  PAL: ["pallet", "pallets"],
  RAS: ["tub", "tubs"],
  GRM: ["gram", "grams"],
  CLT: ["centilitre", "centilitres"],
  MLT: ["millilitre", "millilitres"],
};

// Finnish takes the partitive singular after any number but 1: "2 pakkausta".
const unitsFi: Readonly<Record<string, readonly [string, string]>> = {
  CT: ["pakkaus", "pakkausta"],
  PCE: ["kappale", "kappaletta"],
  LTR: ["litra", "litraa"],
  KGM: ["kilogramma", "kilogrammaa"],
  KG: ["kilogramma", "kilogrammaa"],
  ST: ["kappale", "kappaletta"],
  KI: ["laatikko", "laatikkoa"],
  CS: ["laatikko", "laatikkoa"],
  BAG: ["pussi", "pussia"],
  BOT: ["pullo", "pulloa"],
  DSP: ["esillepanopakkaus", "esillepanopakkausta"],
  DZ: ["tusina", "tusinaa"],
  KRT: ["kartonki", "kartonkia"],
  NIP: ["nippu", "nippua"],
  PAK: ["paketti", "pakettia"],
  PAL: ["lava", "lavaa"],
  RAS: ["rasia", "rasiaa"],
  GRM: ["gramma", "grammaa"],
  CLT: ["senttilitra", "senttilitraa"],
  MLT: ["millilitra", "millilitraa"],
};

const UNIT_NAMES: Record<FormatLang, Readonly<Record<string, readonly [string, string]>>> = {
  en: units,
  fi: unitsFi,
};

export function formatQuantity(
  quantity: { value: number; unit: string },
  lang: FormatLang = "en",
): string {
  if (!Number.isFinite(quantity.value)) return UNAVAILABLE[lang].quantity;
  const amount = quantityFormatter(lang).format(quantity.value);
  const table = UNIT_NAMES[lang];
  const names = Object.hasOwn(table, quantity.unit) ? table[quantity.unit] : undefined;
  return names
    ? `${amount} ${quantity.value === 1 ? names[0] : names[1]}`
    : `${amount} (${UNAVAILABLE[lang].unit})`;
}

export function formatOrderNumber(id: string, lang: FormatLang = "en"): string {
  return id ? id.slice(0, 8) : UNAVAILABLE[lang].order;
}
