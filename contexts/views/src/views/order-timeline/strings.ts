import type { Order } from "@app/contract";
import { CARD } from "../approval-card/card-strings.ts";

// Text of the order timeline, in each view language. Status, actor and outcome words come
// from ORDER_WORDING in @app/ui/format; reason text from the approval card's table.

type Event = Order["audit"][number]["event"];

const en = {
  events: {
    order_requested: "Order requested",
    order_refused: "Order refused",
    offer_verified: "Offer verified",
    check_passed: "Check passed",
    check_failed: "Check failed",
    sent_to_approval: "Sent for approval",
    approved: "Approved",
    declined: "Declined",
    requoted: "Offer requoted",
    edited: "Order edited",
    payment_authorized: "Payment authorized",
    payment_failed: "Payment failed",
    placed: "Order placed",
    rejected: "Order rejected",
  } satisfies Record<Event, string>,
  reason: CARD.en.reason,
  eyebrow: "Order timeline",
  summaryLabel: "Order summary",
  total: (amount: string) => `Total: ${amount}`,
  approvalDeclined: "Approval declined",
  nextNotRecorded: "The next action was not recorded.",
  note: (text: string) => `Note: ${text}`,
  orderLog: "Order log",
  logIntact: (count: number) => `Log intact. All ${count} entries are signed and in order.`,
  logUnverified: "Can’t check the log right now. The entries below are not verified.",
  logBroken: (count: number) =>
    `${count} ${count === 1 ? "entry was" : "entries were"} changed after ${count === 1 ? "it was" : "they were"} written. Don’t rely on this log.`,
  entryChanged:
    "This entry doesn’t match its signature. It may have been edited after it was written.",
  noActivity: "No activity recorded.",
  supportRule: "Support rule available",
  requotedOffers: "Requoted offers",
  previousProduct: (name: string) => `Previous product: ${name}`,
  unitPrice: "Unit price:",
  totalLabel: "Total:",
  entries: (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`,
  facts: { time: "Time", by: "By", detail: "Detail", note: "Note", rule: "Rule" },
  entryLabel: (title: string, time: string, actor: string) => `${title}, ${time}, ${actor}`,
  showMore: "Show more",
  showLess: "Show less",
};

const fi: typeof en = {
  events: {
    order_requested: "Tilausta pyydetty",
    order_refused: "Tilauspyyntö torjuttu",
    offer_verified: "Tarjous tarkistettu",
    check_passed: "Tarkistus läpäisty",
    check_failed: "Tarkistus ei läpäissyt",
    sent_to_approval: "Lähetetty hyväksyttäväksi",
    approved: "Hyväksytty",
    declined: "Hylätty",
    requoted: "Tarjous päivitetty",
    edited: "Tilausta muokattu",
    payment_authorized: "Maksu hyväksytty",
    payment_failed: "Maksu epäonnistui",
    placed: "Tilaus tehty",
    rejected: "Tilaus hylätty",
  },
  reason: CARD.fi.reason,
  eyebrow: "Tilaushistoria",
  summaryLabel: "Tilauksen yhteenveto",
  total: (amount) => `Yhteensä: ${amount}`,
  approvalDeclined: "Hyväksyntä hylätty",
  nextNotRecorded: "Seuraavaa toimea ei kirjattu.",
  note: (text) => `Huomio: ${text}`,
  orderLog: "Tilausloki",
  logIntact: (count) =>
    `Loki on eheä. Kaikki ${count} merkintää on allekirjoitettu ja järjestyksessä.`,
  logUnverified: "Lokia ei voi tarkistaa juuri nyt. Alla olevia merkintöjä ei ole vahvistettu.",
  logBroken: (count) =>
    `${count} ${count === 1 ? "merkintä" : "merkintää"} on muutettu kirjoittamisen jälkeen. Älä luota tähän lokiin.`,
  entryChanged:
    "Merkintä ei vastaa allekirjoitustaan. Sitä on voitu muokata kirjoittamisen jälkeen.",
  noActivity: "Ei kirjattuja tapahtumia.",
  supportRule: "Tukisääntö saatavilla",
  requotedOffers: "Päivitetyt tarjoukset",
  previousProduct: (name) => `Aiempi tuote: ${name}`,
  unitPrice: "Yksikköhinta:",
  totalLabel: "Yhteensä:",
  entries: (count) => `${count} ${count === 1 ? "merkintä" : "merkintää"}`,
  facts: { time: "Aika", by: "Tekijä", detail: "Lisätieto", note: "Huomio", rule: "Sääntö" },
  entryLabel: (title, time, actor) => `${title}, ${time}, ${actor}`,
  showMore: "Näytä lisää",
  showLess: "Näytä vähemmän",
};

export const TIMELINE = { en, fi };
