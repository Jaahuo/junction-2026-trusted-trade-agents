import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { OrderSchema } from "@app/contract";
import pending from "../../../fixtures/approval-card/pending.json";
import trust from "../../../fixtures/approval-card/pending-trust.json";
import mismatch from "../../../fixtures/approval-card/placed-mismatch.json";
import signed from "../../../fixtures/approval-card/placed-signed.json";
import unsigned from "../../../fixtures/approval-card/placed-unsigned.json";
import { setLang } from "../../shared/locale.ts";
import { ApprovalCard } from "./approval-card.ts";
import { money } from "./parts.ts";
import { clickHandler, markup } from "./template-walk.ts";

/** The text a reader sees: tags (with their attributes) removed; the collapsed details too. */
const visible = (card: ApprovalCard, withDetails = false) =>
  markup(card.render(), withDetails ? undefined : '<aside class="details"')
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const cardFor = (data: unknown) => {
  const card = new ApprovalCard();
  card.order = OrderSchema.parse(data);
  const sent: { type: string; detail: unknown }[] = [];
  card.dispatchEvent = (event: Event) => {
    if (event instanceof CustomEvent) sent.push({ type: event.type, detail: event.detail });
    return true;
  };
  return { card, sent };
};
const click = (card: ApprovalCard, marker: string) => {
  const handler = clickHandler(card.render(), marker);
  if (handler === undefined) throw new Error(`no button after ${marker}`);
  handler();
};

const fixtures = resolve(import.meta.dir, "../../../fixtures/approval-card");
const ORDER_FIXTURES = [
  "pending",
  "pending-long-name",
  "pending-new-product",
  "pending-partial",
  "pending-substitution",
  "pending-trust",
  "placed",
  "placed-signed",
  "placed-unsigned",
  "placed-mismatch",
  "awaiting-payment",
  "declined-stop",
  "declined-alternatives",
];

test("the talk button sends a complete request that names the order id", () => {
  const order = OrderSchema.parse(pending);
  const card = new ApprovalCard();
  card.order = order;
  card.canAsk = true;
  const sent: { type: string; detail: unknown }[] = [];
  card.dispatchEvent = (event: Event) => {
    if (event instanceof CustomEvent) sent.push({ type: event.type, detail: event.detail });
    return true;
  };

  const talk = clickHandler(card.render(), 'part="button talk"');
  if (talk === undefined) throw new Error("the pending card shows the talk button");
  talk();

  expect(sent).toEqual([
    {
      type: "tt-talk",
      detail: `I'd like to discuss order ${order.orderId} before I decide. Give me a short summary and ask what I want to change.`,
    },
  ]);
});

test("each total says whether it includes VAT; the limit compares the gross total", () => {
  const { card } = cardFor(pending);
  card.orderLimit = 1700;
  const order = OrderSchema.parse(pending);
  const text = visible(card);
  expect(text).toContain(`Total incl. VAT ${money(order.total.gross)}`);
  expect(text).toContain(`${money(order.total.net)} excl. VAT`);
  expect(text).toContain("Order total excl. VAT");
});

test("approve asks with the gross total and sends only after the second click", () => {
  const { card, sent } = cardFor(pending);
  const order = OrderSchema.parse(pending);
  click(card, 'part="button approve"');
  expect(sent).toEqual([]);
  expect(visible(card)).toContain(`Approve order of ${money(order.total.gross)} incl. VAT?`);
  click(card, 'part="button cancel"');
  expect(visible(card)).not.toContain("Approve order of");
  click(card, 'part="button approve"');
  click(card, 'part="button approve-confirm"');
  expect(sent).toEqual([
    { type: "tt-decide", detail: { decision: "approve", proposalVersion: order.proposalVersion } },
  ]);
});

test("reject asks first, then stops or lets the agent look for alternatives", () => {
  for (const next of ["stop", "alternatives"] as const) {
    const { card, sent } = cardFor(pending);
    click(card, 'part="button reject"');
    expect(sent).toEqual([]);
    const text = visible(card);
    expect(text).toContain("Reject this order?");
    expect(text).toContain("Reject and stop");
    expect(text).toContain("Reject, allow alternatives");
    click(card, `part="button reject-${next}"`);
    expect(sent).toEqual([
      {
        type: "tt-decide",
        detail: { decision: "reject", next, proposalVersion: card.order?.proposalVersion },
      },
    ]);
  }
});

test("no card shows a raw id outside More details; the details keep the order id", async () => {
  for (const name of ORDER_FIXTURES) {
    const data = await Bun.file(resolve(fixtures, `${name}.json`)).json();
    const { card } = cardFor(data);
    const order = OrderSchema.parse(data);
    const ids = [order.orderId, order.customer, order.agentId, order.accountId, ...order.offerIds];
    const text = visible(card);
    for (const id of ids) expect(text, `${name} shows ${id}`).not.toContain(id);
    expect(visible(card, true), name).toContain(order.orderId);
    if (order.status === "declined") expect(text).toContain("Declined");
  }
});

/** The card's markup with tags kept, collapsed to single spaces. */
const rendered = (fixture: unknown) => markup(cardFor(fixture).card.render()).replace(/\s+/g, " ");

test("purpose, rationale and allergen chips show with the to-dos they add (#74)", () => {
  const output = rendered(trust);
  expect(output).toContain("Purpose");
  expect(output).toContain(trust.purpose);
  expect(output).toContain("Your usual flour. Cheapest 20 kg sack that arrives Monday.");
  expect(output).toContain("Free from lactose");
  // A trace risk and a broken rule each add a to-do; the line shows only the red chip.
  expect(output).toContain("May contain sesame");
  expect(output).toContain("Check it suits your sesame rule");
  expect(output.match(/Breaks your rule: no egg/g)?.length).toBe(1);
  expect(output).toContain("Contains egg");
  // Confirm stays enabled: the server refuses a broken rule.
  expect(output).not.toMatch(/part="button approve"[^>]*disabled/);
});

test("an order without trust fields shows none of their parts", () => {
  const output = rendered(pending);
  expect(output).not.toContain("Purpose");
  expect(output).not.toContain('class="allergens"');
  expect(output).not.toContain("Breaks your rule");
});

test("the offer seal and the receipt seal say whether the signature holds", () => {
  for (const [state, title] of [
    ["verified", "Signed offer from"],
    ["expired", "Offer expired"],
    ["invalid", "Signature doesn’t match"],
  ] as const)
    expect(rendered({ ...trust, offerSignature: { ...trust.offerSignature, state } })).toContain(
      title,
    );
  for (const [fixture, title] of [
    [signed, "Signed confirmation from"],
    [unsigned, "Confirmation not signed yet"],
    [mismatch, "Confirmation doesn’t match your order"],
  ] as const) {
    const output = rendered(fixture);
    expect(output).toContain("Order sent");
    expect(output).toContain(title);
    expect(output).toContain("excl. VAT");
  }
});

test("the trust parts follow the view language", () => {
  setLang("fi");
  try {
    const output = rendered(trust);
    expect(output).toContain("Tarkoitus");
    expect(output).toContain("Voi sisältää sesame");
    expect(output).toContain("Rikkoo sääntöäsi: no egg");
  } finally {
    setLang("en");
  }
});
