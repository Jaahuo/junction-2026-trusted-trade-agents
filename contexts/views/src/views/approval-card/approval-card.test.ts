import { expect, test } from "bun:test";
import { type Order, OrderSchema } from "@app/contract";
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
import { amount, day } from "./parts.ts";

const isTemplate = (value: unknown): value is { strings: readonly string[]; values: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "strings" in value &&
  "values" in value &&
  Array.isArray(value.strings) &&
  Array.isArray(value.values);

/** The `@click` handler of the button whose markup contains `marker`, found without a DOM. */
const clickHandler = (value: unknown, marker: string): (() => void) | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = clickHandler(item, marker);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isTemplate(value)) return undefined;
  if (value.strings.join("").includes(marker)) {
    const index = value.strings.findIndex((part) => part.trimEnd().endsWith("@click="));
    const handler = value.values[index];
    if (typeof handler === "function") return () => handler();
  }
  for (const nested of value.values) {
    const found = clickHandler(nested, marker);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The rendered text and attribute values of a template, in order, without a DOM. */
const flatten = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (isTemplate(value))
    return value.strings.map((part, i) => part + flatten(value.values[i])).join("");
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};

/** A pending card for `order` that records the events it sends. */
const cardFor = (order: Order) => {
  const card = new ApprovalCard();
  card.order = order;
  card.canAsk = true;
  const sent: { type: string; detail: unknown }[] = [];
  card.dispatchEvent = (event: Event) => {
    if (event instanceof CustomEvent) sent.push({ type: event.type, detail: event.detail });
    return true;
  };
  return { card, sent };
};

const firstClaims = (order: Order) => {
  const line = order.lines[0];
  if (line === undefined) throw new Error("the fixture has a line");
  return line.claims;
};

test("a line with a shortfall gets a to-do naming the amount short, linked to its choices", () => {
  const text = pick(CARD);
  const order = OrderSchema.parse(pendingPartial);
  const c = firstClaims(order);
  if (c.shortfall === null) throw new Error("the partial fixture's first line is short");
  const shown = flatten(cardFor(order).card.render());

  expect(shown).toContain(text.shortForDelivery(amount(c.shortfall)));
  expect(shown).toContain(text.chooseHowToHandle);
  expect(shown).toContain(text.howToHandle(amount(c.shortfall)));
  expect(shown).toContain(`id="line-${c.offerId}"`);
  expect(shown).not.toContain(text.checkYouWantProduct);
  expect(reasonSummaries(order)).toEqual([text.notAllOnTime(c.product.name)]);
});

test("a late line with no shortfall is flagged and gets a to-do naming the delivery date", () => {
  const text = pick(CARD);
  const order = OrderSchema.parse(pendingLate);
  const c = firstClaims(order);
  const shown = flatten(cardFor(order).card.render());

  expect(shown).toContain(text.arrivesOn(day(c.deliveryDate), day(c.requestedDate)));
  expect(shown).toContain(text.approveOrRemove);
  expect(shown).toContain('class="product flagged"');
  expect(shown).toContain(text.letAgentFindOnTime);
  expect(shown).not.toContain("short for this delivery");
  expect(reasonSummaries(order)).toEqual([text.arrivesLateNamed(c.product.name)]);
});

test("a line that is late and short gets one to-do per case", () => {
  const text = pick(CARD);
  const order = OrderSchema.parse(pendingPartial);
  const c = firstClaims(order);
  if (c.shortfall === null) throw new Error("the partial fixture's first line is short");
  c.deliveryDate = "2026-11-18";
  const shown = flatten(cardFor(order).card.render());

  expect(shown).toContain(text.shortForDelivery(amount(c.shortfall)));
  expect(shown).toContain(text.arrivesOn(day(c.deliveryDate), day(c.requestedDate)));
});

test("a late line's choices send approve, remove or the agent prompt", () => {
  const text = pick(CARD);
  const order = OrderSchema.parse(pendingLate);
  const c = firstClaims(order);

  const approving = cardFor(order);
  const approve = clickHandler(approving.card.render(), 'part="button approve"');
  if (approve === undefined) throw new Error("the pending card shows the approve button");
  approve();
  expect(approving.sent).toEqual([
    { type: "tt-decide", detail: { decision: "approve", proposalVersion: order.proposalVersion } },
  ]);

  const removing = cardFor(order);
  const remove = clickHandler(removing.card.render(), 'class="link-button"');
  if (remove === undefined) throw new Error("the late line shows its remove button");
  remove();
  const confirm = clickHandler(removing.card.render(), 'part="button approve"');
  if (confirm === undefined) throw new Error("the pending card shows the approve button");
  confirm();
  expect(removing.sent).toEqual([
    {
      type: "tt-confirm-changes",
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

/** The template's text without a DOM: static markup and nested values, tags kept. */
const text = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(text).join(" ")
    : isTemplate(value)
      ? value.strings.map((part, i) => `${part} ${text(value.values[i])}`).join(" ")
      : typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
const rendered = (fixture: unknown) => {
  const card = new ApprovalCard();
  card.order = OrderSchema.parse(fixture);
  return text(card.render()).replace(/\s+/g, " ");
};

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
