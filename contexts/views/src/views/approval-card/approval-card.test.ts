import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DecideApprovalRequestSchema, type Order, OrderSchema } from "@app/contract";
import pendingLate from "../../../fixtures/approval-card/pending-late.json";
import pendingPartial from "../../../fixtures/approval-card/pending-partial.json";
import pending from "../../../fixtures/approval-card/pending.json";
import trust from "../../../fixtures/approval-card/pending-trust.json";
import mismatch from "../../../fixtures/approval-card/placed-mismatch.json";
import signed from "../../../fixtures/approval-card/placed-signed.json";
import unsigned from "../../../fixtures/approval-card/placed-unsigned.json";
import { pick, setLang } from "../../shared/locale.ts";
import { ApprovalCard, reasonSummaries } from "./approval-card.ts";
import { CARD } from "./card-strings.ts";
import { day, money } from "./parts.ts";
import { clickHandler, handlers, markup } from "./template-walk.ts";

/** The text a reader sees: tags (with their attributes) removed; the collapsed details too. */
const visible = (card: ApprovalCard, withDetails = false) =>
  markup(card.render(), withDetails ? undefined : '<aside class="details"')
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A pending card in a chat for the order in `data`, recording the events it sends. */
const cardFor = (data: unknown) => {
  const card = new ApprovalCard();
  card.order = OrderSchema.parse(data);
  card.canAsk = true;
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
  "pending-late",
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

const firstClaims = (order: Order) => {
  const line = order.lines[0];
  if (line === undefined) throw new Error("the fixture has a line");
  return line.claims;
};

test("a line with a shortfall gets a to-do naming what arrives, linked to its choices", () => {
  const text = pick(CARD);
  const order = OrderSchema.parse(pendingPartial);
  const c = firstClaims(order);
  const shown = markup(cardFor(order).card.render());

  // 24 packs of 0.5 kg arrive; the 8 kg shortfall is 16 packs.
  expect(shown).toContain(text.onlyCanArrive("24", text.packs("40"), day(c.deliveryDate)));
  expect(shown).toContain(text.chooseHowToDeliver);
  expect(shown).toContain(text.howToHandle(text.packs("16")));
  expect(shown).toContain(text.twoDeliveries);
  expect(shown).toContain(`id="line-${c.offerId}"`);
  expect(shown).not.toContain(text.checkYouWantProduct);
  expect(reasonSummaries(order)).toEqual([text.notAllOnTime(c.product.name)]);
});

test("a late line with no shortfall is flagged with the same choices as a short line", () => {
  const text = pick(CARD);
  const order = OrderSchema.parse(pendingLate);
  const c = firstClaims(order);
  const shown = markup(cardFor(order).card.render());

  expect(shown).toContain(
    text.canArriveLate(day(c.deliveryDate), text.days(2), day(c.requestedDate)),
  );
  expect(shown).toContain(text.chooseHowToDeliver);
  expect(shown).toContain('class="product flagged"');
  expect(shown).toContain(text.howToHandleLate);
  expect(shown).toContain(text.deliverOn(day(c.deliveryDate)));
  expect(shown).toContain(text.letAgentSort);
  expect(shown).not.toContain(text.onlyCanArrive("24", text.packs("24"), day(c.deliveryDate)));
  expect(reasonSummaries(order)).toEqual([text.arrivesLateNamed(c.product.name)]);
});

test("a line that is late and short gets one to-do per case", () => {
  const text = pick(CARD);
  const order = OrderSchema.parse(pendingPartial);
  const c = firstClaims(order);
  c.deliveryDate = "2026-11-18";
  const shown = markup(cardFor(order).card.render());

  expect(shown).toContain(text.onlyCanArrive("24", text.packs("40"), day(c.deliveryDate)));
  expect(shown).toContain(
    text.canArriveLate(day(c.deliveryDate), text.days(2), day(c.requestedDate)),
  );
});

test("a late line's choices send approve, remove or the agent prompt", () => {
  const text = pick(CARD);
  const order = OrderSchema.parse(pendingLate);
  const c = firstClaims(order);

  const approving = cardFor(order);
  click(approving.card, 'part="button approve"');
  click(approving.card, 'part="button approve-confirm"');
  expect(approving.sent).toEqual([
    { type: "tt-decide", detail: { decision: "approve", proposalVersion: order.proposalVersion } },
  ]);

  const removing = cardFor(order);
  const more = clickHandler(removing.card.render(), 'class="more-products"');
  if (more === undefined) throw new Error("the late line shows its other choices");
  more();
  // The second handling radio is "Remove from this order".
  const [, removeRadio] = handlers(removing.card.render(), 'name="handling-', "@change=");
  if (removeRadio === undefined) throw new Error("the late line offers removal");
  removeRadio();
  click(removing.card, 'part="button approve"');
  click(removing.card, 'part="button approve-confirm"');
  expect(removing.sent).toEqual([
    {
      type: "tt-decide",
      detail: {
        decision: "edit",
        proposalVersion: order.proposalVersion,
        changes: [{ productId: c.productId, quantity: { value: 0, unit: c.quantity.unit } }],
      },
    },
  ]);

  const asking = cardFor(order);
  const ask = clickHandler(asking.card.render(), 'class="btn secondary"');
  if (ask === undefined) throw new Error("the late line shows the agent help");
  ask();
  expect(asking.sent).toEqual([
    {
      type: "tt-ask-agent",
      detail: text.latePrompt(c.product.name, day(c.requestedDate), day(c.deliveryDate)),
    },
  ]);
});

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
    expect(output).toContain("Voi sisältää seesaminsiemeniä");
    expect(output).toContain("Rikkoo sääntöäsi: ei kananmunaa");
    expect(output).toContain("Tarkista, sopiiko se sääntöösi: ei seesaminsiemeniä");
  } finally {
    setLang("en");
  }
});

test("reduce to fit fills the amounts on the card, sends nothing, and confirm sends the edit", () => {
  const { card, sent } = cardFor(pending);
  const order = OrderSchema.parse(pending);
  card.orderLimit = 1700;
  expect(visible(card)).toContain("Over your limit");
  click(card, 'part="reduce"');
  expect(sent).toEqual([]);
  const text = visible(card);
  expect(text).toContain(pick(CARD).reducedToFit(money(1700)));
  expect(text).toContain("Under your limit");

  click(card, 'part="button approve"');
  click(card, 'part="button approve-confirm"');
  const [only] = sent;
  if (only?.type !== "tt-confirm-changes") throw new Error("confirm sends the changed amounts");
  const detail = DecideApprovalRequestSchema.parse(only.detail);
  if (detail.decision !== "edit") throw new Error("the changed amounts are sent as an edit");
  expect(detail.changes.length).toBeGreaterThan(0);
  for (const change of detail.changes) {
    const was = order.lines.find((l) => l.claims.productId === change.productId)?.claims;
    const amount = change.quantity?.value ?? 0;
    expect(amount).toBeGreaterThanOrEqual(1);
    expect(amount).toBeLessThan(was?.quantity.value ?? 0);
  }
});

test("reduce to fit says so when even one of each is over the limit, and changes nothing", () => {
  const { card, sent } = cardFor(pending);
  card.orderLimit = 10;
  click(card, 'part="reduce"');
  expect(sent).toEqual([]);
  expect(visible(card)).toContain(pick(CARD).cannotFit);
  click(card, 'part="button approve"');
  click(card, 'part="button approve-confirm"');
  expect(sent[0]?.type).toBe("tt-decide");
});

test("without a known order limit there is nothing to reduce to", () => {
  const { card } = cardFor(pending);
  card.orderLimit = null;
  expect(markup(card.render())).not.toContain('part="reduce"');
});
