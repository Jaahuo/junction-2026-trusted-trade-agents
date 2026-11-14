import { expect, test } from "bun:test";
import { OrderSchema } from "@app/contract";
import pending from "../../../fixtures/approval-card/pending.json";
import trust from "../../../fixtures/approval-card/pending-trust.json";
import mismatch from "../../../fixtures/approval-card/placed-mismatch.json";
import signed from "../../../fixtures/approval-card/placed-signed.json";
import unsigned from "../../../fixtures/approval-card/placed-unsigned.json";
import { setLang } from "../../shared/locale.ts";
import { ApprovalCard } from "./approval-card.ts";

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
  // A trace risk adds a to-do; a broken rule adds a to-do and a box on its line.
  expect(output).toContain("May contain sesame");
  expect(output).toContain("Check it suits your sesame rule");
  expect(output.match(/Breaks your rule: no egg/g)?.length).toBe(2);
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
