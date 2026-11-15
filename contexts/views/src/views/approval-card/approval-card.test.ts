import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Order, OrderSchema } from "@app/contract";
import standingOffer from "../../../fixtures/approval-card/approved-standing-offer.json";
import declinedSubstitution from "../../../fixtures/approval-card/declined-substitution.json";
import pendingLate from "../../../fixtures/approval-card/pending-late.json";
import pendingNew from "../../../fixtures/approval-card/pending-new-product.json";
import pendingPartial from "../../../fixtures/approval-card/pending-partial.json";
import pending from "../../../fixtures/approval-card/pending.json";
import trust from "../../../fixtures/approval-card/pending-trust.json";
import mismatch from "../../../fixtures/approval-card/placed-mismatch.json";
import signed from "../../../fixtures/approval-card/placed-signed.json";
import unsigned from "../../../fixtures/approval-card/placed-unsigned.json";
import { pick, setLang } from "../../shared/locale.ts";
import { pricePerStdUnit } from "../offer-comparison/model.ts";
import { OFFERS } from "../offer-comparison/strings.ts";
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
  "approved-standing-offer",
  "declined-substitution",
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

/** pending-partial with a substitute in the order that covers the butter's missing 8 kg. */
const toppedUp = () => {
  const order = OrderSchema.parse(pendingPartial);
  const short = firstClaims(order);
  const [line] = order.lines;
  if (line === undefined) throw new Error("Expected the short line");
  const claims = {
    ...short,
    offerId: "off_test_topup",
    productId: "prod_test_topup",
    product: {
      ...short.product,
      name: "Test butter 250 g",
      perSalesUnit: { value: 0.25, unit: "KGM" },
    },
    quantity: { value: 32, unit: "CT" },
    total: { net: 60, gross: 68.4 },
    shortfall: null,
    replaces: short.productId,
  };
  order.lines.push({ ...line, offerId: claims.offerId, claims });
  order.offerIds.push(claims.offerId);
  order.reasons.push("SUBSTITUTION");
  return { order, short };
};

test("a substitute that tops up a short line is one of its choices, not an out-of-stock product", () => {
  const text = pick(CARD);
  const { order, short } = toppedUp();
  const shown = markup(cardFor(order).card.render());

  expect(shown).toContain(text.howToHandle(text.packs("16")));
  expect(shown).toContain(text.topUpWith("Test butter 250 g"));
  expect(shown).toContain(text.otherChoices(3));
  expect(shown).not.toContain(text.replaceWith);
  expect(shown).not.toContain(text.chooseReplacement);
  expect(shown).not.toContain('id="line-off_test_topup"');
  expect(reasonSummaries(order)).toEqual([text.notAllOnTime(short.product.name)]);
});

test("the top-up is approved as it is; Order fewer drops it from the order", () => {
  const { order, short } = toppedUp();
  const approving = cardFor(order);
  click(approving.card, 'part="button approve"');
  expect(approving.sent).toEqual([
    { type: "tt-decide", detail: { decision: "approve", proposalVersion: order.proposalVersion } },
  ]);

  const fewer = cardFor(order);
  const more = clickHandler(fewer.card.render(), 'class="more-products"');
  if (more === undefined) throw new Error("the short line shows its other choices");
  more();
  // Top up, split, all later, then Order fewer.
  const radios = handlers(fewer.card.render(), 'name="handling-', "@change=");
  radios[3]?.();
  click(fewer.card, 'part="button approve"');
  expect(fewer.sent).toEqual([
    {
      type: "tt-decide",
      detail: {
        decision: "edit",
        proposalVersion: order.proposalVersion,
        changes: [
          { productId: "prod_test_topup", quantity: { value: 0, unit: "CT" } },
          { productId: short.productId, quantity: { value: 24, unit: "CT" } },
        ],
      },
    },
  ]);
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

test("one click approves", () => {
  const { card, sent } = cardFor(pending);
  click(card, 'part="button approve"');
  expect(sent).toEqual([
    {
      type: "tt-decide",
      detail: { decision: "approve", proposalVersion: card.order?.proposalVersion },
    },
  ]);
});

test("one click rejects, and the agent stops", () => {
  const { card, sent } = cardFor(pending);
  click(card, 'part="button reject"');
  expect(sent).toEqual([
    {
      type: "tt-decide",
      detail: { decision: "reject", next: "stop", proposalVersion: card.order?.proposalVersion },
    },
  ]);
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

const SUBSTITUTE = "Test plant-based yogurt unsweetened 400 g";
const ORIGINAL = "Test plant-based yogurt 750 g";

test("the server's standing offer asks to stop asking; Yes sends the auto rule", () => {
  const text = pick(CARD);
  const { card, sent } = cardFor(standingOffer);
  expect(visible(card)).toContain(text.standingOffer(SUBSTITUTE, ORIGINAL, 3));
  click(card, 'part="rule"');
  expect(sent).toEqual([
    {
      type: "tt-remember",
      detail: {
        replaces: "prod_test_yogurt_750",
        productId: "prod_test_yogurt_400",
        policy: "auto",
        productName: SUBSTITUTE,
        replacesName: ORIGINAL,
      },
    },
  ]);
  card.remembered = true;
  expect(visible(card)).toContain(text.standingSaved(SUBSTITUTE, ORIGINAL));
});

test("Keep asking hides the offer, and an approval without the offer shows none", () => {
  const text = pick(CARD);
  const { card } = cardFor(standingOffer);
  click(card, 'class="btn ghost"');
  expect(visible(card)).not.toContain(text.keepAsking);
  const { standingOffer: _offer, ...plain } = standingOffer;
  expect(visible(cardFor(plain).card)).not.toContain(text.yesAutomatically);
});

test("a declined substitute offers one tap to stop suggesting it", () => {
  const text = pick(CARD);
  const { card, sent } = cardFor(declinedSubstitution);
  expect(visible(card)).toContain(text.neverSuggest(SUBSTITUTE, ORIGINAL));
  click(card, 'class="rule"');
  expect(sent).toMatchObject([{ type: "tt-remember", detail: { policy: "never" } }]);
  card.remembered = true;
  expect(visible(card)).toContain(text.neverSaved(SUBSTITUTE, ORIGINAL));
});

for (const next of ["stop", "alternatives"] as const) {
  test(`a server decline with next ${next} does not offer a standing substitution rule`, () => {
    const text = pick(CARD);
    const order = OrderSchema.parse(declinedSubstitution);
    for (const event of order.audit) {
      if (event.event === "declined") event.actor = "server";
    }
    const { card } = cardFor({
      ...order,
      decision: { ...order.decision, action: "reject", next, by: "server" },
    });
    expect(visible(card)).not.toContain(text.dontSuggestAgain);
    expect(visible(card)).not.toContain(text.neverSuggest(SUBSTITUTE, ORIGINAL));
  });
}

test("a pair that already has a rule is not offered again", () => {
  const text = pick(CARD);
  const { card } = cardFor(declinedSubstitution);
  card.rules = [
    {
      replaces: "prod_test_yogurt_750",
      productId: "prod_test_yogurt_400",
      policy: "never",
      decidedAt: "2026-11-14T10:00:00+00:00",
    },
  ];
  expect(visible(card)).not.toContain(text.dontSuggestAgain);
  card.remembered = true;
  expect(visible(card)).toContain(text.neverSaved(SUBSTITUTE, ORIGINAL));
});

test("the rule offers follow the view language", () => {
  setLang("fi");
  try {
    expect(visible(cardFor(standingOffer).card)).toContain("Saako agentti tehdä tämän kysymättä?");
    expect(visible(cardFor(declinedSubstitution).card)).toContain("Älä ehdota enää");
  } finally {
    setLang("en");
  }
});

test("reduce to fit asks the agent without changing amounts, even for a very low limit", () => {
  for (const limit of [1700, 10]) {
    const { card, sent } = cardFor(pending);
    const order = OrderSchema.parse(pending);
    card.orderLimit = limit;
    const before = markup(card.render());
    click(card, 'part="reduce"');
    expect(sent).toEqual([
      { type: "tt-ask-agent", detail: pick(CARD).reducePrompt(order.orderId) },
    ]);
    expect(markup(card.render())).toBe(before);
    click(card, 'part="button approve"');
    expect(sent[1]?.type).toBe("tt-decide");
  }
});

test("over the limit in a chat, each reduce chip asks the agent; under it or outside a chat, none show", () => {
  const { card, sent } = cardFor(pending);
  const order = OrderSchema.parse(pending);
  const text = pick(CARD);
  card.orderLimit = 1700;
  expect(visible(card)).toContain(text.orTellIt);
  const chips = handlers(card.render(), 'class="chip"', "@click=");
  expect(chips.length).toBe(text.reduceChips.length);
  chips.forEach((chip) => chip());
  expect(sent).toEqual(
    text.reduceChips.map((chip) => ({
      type: "tt-ask-agent",
      detail: `${text.reducePrompt(order.orderId)} ${chip}.`,
    })),
  );

  card.canAsk = false;
  expect(visible(card)).not.toContain(text.reduceChips[0]);
  expect(markup(card.render())).not.toContain('part="reduce"');
  card.canAsk = true;
  card.orderLimit = 100000;
  expect(visible(card)).not.toContain(text.reduceChips[0]);
});

test("without a known order limit there is nothing to reduce to", () => {
  const { card } = cardFor(pending);
  card.orderLimit = null;
  expect(markup(card.render())).not.toContain('part="reduce"');
});

/** Each product row's offer summary, by offerId: status, short reason, price and toggle. */
const offerRows = (card: ApprovalCard) =>
  new Map(
    markup(card.render())
      .split('class="line-offer"')
      .slice(1)
      .map((block) => {
        const id = /aria-controls=offer-(\S+)/.exec(block)?.[1] ?? "";
        const field = (pattern: RegExp) => pattern.exec(block)?.[1]?.trim() ?? "";
        return [
          id,
          {
            expanded: field(/aria-expanded=(\w+)/),
            label: field(/aria-label=(.*?)\s+@click=/s),
            status: field(/offer-status (\w+)/),
            reason: field(/class="offer-reason">([^<]*)</),
            price: field(/class="offer-price">([^<]*)</),
            block,
          },
        ];
      }),
  );
const lineOf = (data: unknown, productId: string) => {
  const line = OrderSchema.parse(data).lines.find((l) => l.claims.productId === productId);
  if (line === undefined) throw new Error(`no line for ${productId}`);
  return line.claims;
};
const rowOf = (card: ApprovalCard, offerId: string) => {
  const row = offerRows(card).get(offerId);
  if (row === undefined) throw new Error(`no offer row for ${offerId}`);
  return row;
};
const MILK = "prod_test_off_test_10";
const FLOUR = "prod_test_off_test_11";

test("each product row shows the status icon, the short reason and the price per l/kg", () => {
  const text = pick(OFFERS);
  const over = cardFor(pending).card;
  over.orderLimit = 1000;
  const milk = lineOf(pending, MILK);
  const milkRow = rowOf(over, milk.offerId);
  expect(milkRow.status).toBe("attention");
  expect(milkRow.reason).toBe(text.short.SPEND_OVER_LIMIT);
  expect(milkRow.price).toBe(pricePerStdUnit(milk)?.shown ?? "missing");
  expect(milkRow.label).toContain(text.words.needsApproval);
  const flour0 = rowOf(over, lineOf(pending, FLOUR).offerId);
  expect([flour0.status, flour0.reason]).toEqual(["auto", ""]);

  const fresh = cardFor(pendingNew).card;
  const barista = rowOf(fresh, lineOf(pendingNew, "prod_test_off_test_17").offerId);
  expect([barista.status, barista.reason]).toEqual(["attention", text.short.NEW_PRODUCT]);
  const flour = rowOf(fresh, lineOf(pendingNew, "prod_test_off_test_11").offerId);
  expect(flour.reason).toBe(text.short.CO2_ABOVE_MAX);

  const short = rowOf(
    cardFor(pendingPartial).card,
    lineOf(pendingPartial, "prod_test_off_test_18").offerId,
  );
  expect(short.status).toBe("attention");
  expect(short.reason).toMatch(/ of /);
  const late = rowOf(
    cardFor(pendingLate).card,
    lineOf(pendingLate, "prod_test_off_test_18").offerId,
  );
  expect(late.reason).toMatch(/late/);

  expect(offerRows(cardFor(signed).card).size).toBe(0);
});

test("the chevron opens one product's details and closes the others", () => {
  const { card } = cardFor(pending);
  card.orderLimit = 1000;
  const milk = lineOf(pending, MILK).offerId;
  const flour = lineOf(pending, FLOUR).offerId;
  expect([...offerRows(card).values()].every((row) => row.expanded === "false")).toBe(true);
  click(card, `aria-controls=offer-${milk}`);
  expect(rowOf(card, milk).expanded).toBe("true");
  expect(rowOf(card, milk).block).toContain(pick(OFFERS).needsYourApproval);
  expect(rowOf(card, milk).block).toContain(`id=offer-${milk}`);
  click(card, `aria-controls=offer-${flour}`);
  expect([rowOf(card, milk).expanded, rowOf(card, flour).expanded]).toEqual(["false", "true"]);
  click(card, `aria-controls=offer-${flour}`);
  expect([...offerRows(card).values()].every((row) => row.expanded === "false")).toBe(true);
});

test("missing reliability or CO2 reads No data, never 0", () => {
  const order = OrderSchema.parse(pending);
  const [first, ...rest] = order.lines;
  if (first === undefined) throw new Error("no line");
  const product = { ...first.claims.product, deliveryReliability: null, co2PerKg: null };
  const blank = { ...order, lines: [{ ...first, claims: { ...first.claims, product } }, ...rest] };
  const { card } = cardFor(blank);
  click(card, `aria-controls=offer-${first.claims.offerId}`);
  const text = pick(OFFERS);
  const block = rowOf(card, first.claims.offerId).block.replace(/>\s+</g, "><");
  expect(block).toContain(`<dt>${text.labels.reliability}</dt><dd>${text.noData}</dd>`);
  expect(block).toContain(`<dt>${text.labels.co2}</dt><dd>${text.noData}</dd>`);
});

test("Finnish renders the product row and its details", () => {
  setLang("fi");
  try {
    const { card } = cardFor(pending);
    card.orderLimit = 1000;
    const milk = lineOf(pending, MILK).offerId;
    expect(rowOf(card, milk).reason).toBe(OFFERS.fi.short.SPEND_OVER_LIMIT);
    expect(rowOf(card, milk).label).toContain(CARD.fi.offerDetails);
    expect(rowOf(card, milk).label).not.toContain(CARD.en.offerDetails);
    click(card, `aria-controls=offer-${milk}`);
    expect(rowOf(card, milk).block).toContain(OFFERS.fi.needsYourApproval);
  } finally {
    setLang("en");
  }
});

test("no agent prompt promises approval of the replacement order", () => {
  for (const text of [CARD.en, CARD.fi]) {
    const prompts = [
      text.reducePrompt("ord_test"),
      text.findPrompt("Test milk", "out of stock"),
      text.shortPrompt(2, 5, "Test milk", "Monday"),
      text.latePrompt("Test milk", "Monday", "Tuesday"),
    ];
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/for approval|to approve|hyväksyttäväksi/);
      expect(prompt).toMatch(/only if a rule asks|vain, jos jokin sääntö vaatii/);
    }
  }
});
