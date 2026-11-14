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

const deliveryDateFormatter = new Intl.DateTimeFormat("en-FI", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const timestampFormatter = new Intl.DateTimeFormat("en-FI", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const quantityFormatter = new Intl.NumberFormat("en-FI", { maximumFractionDigits: 20 });

export function formatMoney(value: number, currency: string, basis: "net" | "gross"): string {
  if (!Number.isFinite(value) || !/^[A-Za-z]{3}$/.test(currency))
    return `Amount unavailable (${basis})`;
  try {
    return `${new Intl.NumberFormat("en-FI", { style: "currency", currency: currency.toUpperCase() }).format(value)} (${basis})`;
  } catch {
    return `Amount unavailable (${basis})`;
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

export function formatDeliveryDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || !validDateParts(Number(match[1]), Number(match[2]), Number(match[3])))
    return "Delivery date unavailable";
  const date = new Date(`${value}T00:00:00Z`);
  return deliveryDateFormatter.format(date);
}

export function formatTimestamp(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (
    !match ||
    !validDateParts(Number(match[1]), Number(match[2]), Number(match[3])) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    return "Time unavailable";
  const zone = match[7];
  if (!zone || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)))
    return "Time unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return `${timestampFormatter.format(date)} UTC`;
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

export function formatQuantity(quantity: { value: number; unit: string }): string {
  if (!Number.isFinite(quantity.value)) return "Quantity unavailable";
  const amount = quantityFormatter.format(quantity.value);
  const names = Object.hasOwn(units, quantity.unit) ? units[quantity.unit] : undefined;
  return names
    ? `${amount} ${quantity.value === 1 ? names[0] : names[1]}`
    : `${amount} (unit unknown)`;
}

export function formatOrderNumber(id: string): string {
  return id ? id.slice(0, 8) : "Order number unavailable";
}
