import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fixtures, type OfferLine, type OffersResult, OffersResultSchema } from "@app/contract";
import {
  accessibleName,
  closed,
  details,
  explain,
  failed,
  limitFor,
  linkState,
  type OfferedRow,
  orderNote,
  pricePerStdUnit,
  retryText,
  rowsOf,
  SEND_FAILED,
  sending,
  sent,
  shortReason,
  show,
  steerStatus,
  toggle,
  type Ui,
  useText,
} from "./model.ts";
import { setLang } from "../../shared/locale.ts";
import { renderLoading, renderOfferComparison } from "./offer-comparison.ts";

const fixture = async (name: string): Promise<OffersResult> =>
  OffersResultSchema.parse(
    await Bun.file(
      resolve(import.meta.dir, `../../../fixtures/offer-comparison/${name}.json`),
    ).json(),
  );

// Traverse the rendered Lit templates without a browser DOM.
const text = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (
    value &&
    typeof value === "object" &&
    "strings" in value &&
    "values" in value &&
    Array.isArray(value.strings) &&
    Array.isArray(value.values)
  ) {
    const values: unknown[] = value.values;
    return value.strings
      .map((part: string, index: number) => `${part}${text(values[index])}`)
      .join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};
const visible = (value: unknown) =>
  text(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const first = <T>(items: readonly T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("Expected an item");
  return item;
};
const offeredRows = (data: OffersResult) =>
  rowsOf(data).flatMap((row) => (row.kind === "offered" ? [row] : []));
const named = (data: OffersResult, name: string): OfferedRow => {
  const row = offeredRows(data).find((r) => r.name === name);
  if (row === undefined) throw new Error(`Expected a row for ${name}`);
  return row;
};
const lineOf = (data: OffersResult, productId: string): OfferLine => {
  const line = data.offers.find((o) => o.claims.productId === productId);
  if (line === undefined) throw new Error(`Expected an offer for ${productId}`);
  return line;
};
const inHost = (ui: Partial<Ui>): Ui => ({ ...closed, canSteer: true, ...ui });
const openAt = (key: string, panel: "summary" | "options" | "details" = "summary") => ({
  key,
  panel,
  offerId: null,
});
const BUTTER = "Test butter 500 g";
/** Intl puts a no-break space before the € and the % in Finnish. */
const plain = (value: string | undefined) => value?.replace(/\s/g, " ");

describe("price per standard unit", () => {
  test("is total net / (quantity × perSalesUnit), per litre or kilogram", async () => {
    const data = await fixture("offers");
    // 58.56 net for 48 packs of 1 l; 1503.60 net for 358 packs of 0.5 kg
    expect(pricePerStdUnit(lineOf(data, "prod_test_milk_drink").claims)?.shown).toBe("€1.22/L");
    expect(pricePerStdUnit(lineOf(data, "prod_test_butter").claims)).toEqual({
      shown: "€8.40/kg",
      spoken: "€8.40 per kg",
    });
  });

  test("shows — on the row and No data in its details when perSalesUnit is null", async () => {
    const data = await fixture("offers");
    const line = lineOf(data, "prod_test_cooking_cream");
    const noPack = {
      ...line,
      claims: { ...line.claims, product: { ...line.claims.product, perSalesUnit: null } },
    };
    const row = first(offeredRows({ offers: [noPack], omitted: [] }));
    expect(row.price).toBeNull();
    expect(visible(renderOfferComparison({ offers: [noPack], omitted: [] }))).toContain("—");
    expect(accessibleName(row)).toContain("price per unit unknown");
    expect(details(row.pick)).toContainEqual(["Price per l/kg", "No data"]);
  });

  test("is only given per litre or kilogram", async () => {
    const line = lineOf(await fixture("offers"), "prod_test_cooking_cream");
    const pieces = {
      ...line.claims,
      product: { ...line.claims.product, perSalesUnit: { value: 6, unit: "PCE" } },
    };
    expect(pricePerStdUnit(pieces)).toBeNull();
  });
});

describe("the glance", () => {
  test("has one row per requested line with a status, reason and price", async () => {
    const data = await fixture("offers");
    expect(
      rowsOf(data).map((r) => [
        r.status,
        r.reason,
        r.kind === "offered" ? (r.price?.shown ?? "—") : null,
      ]),
    ).toEqual([
      ["auto", null, "€1.22/L"],
      ["auto", null, "€2.85/L"],
      ["attention", "Over limit", "€8.40/kg"],
      ["attention", "2 days late", "€11.90/kg"],
      ["none", "Not available", null],
    ]);
    const output = visible(renderOfferComparison(data));
    expect(output).toContain("5 products · Mon 23 Nov");
    expect(output).toContain("until");
    // A product that is not offered has no price on its row.
    expect(output).toContain("Product prod_test_whipping_cream Not available Each product");
  });

  test("the header is the branded bar with the logo, and every row has a chevron", async () => {
    const data = await fixture("offers");
    const output = text(renderOfferComparison(data));
    expect(output).toContain('part="header"');
    expect(output).toContain("Valio Aimo");
    expect(count(output, 'class="chevron"')).toBe(5);
  });

  test("names the row's status in words", async () => {
    const data = await fixture("offers");
    const [milk, , butter, , whipping] = rowsOf(data);
    if (milk === undefined || butter === undefined || whipping === undefined)
      throw new Error("Expected five rows");
    expect(accessibleName(milk)).toBe(
      "Test milk drink 1 l, lactose free, no approval needed for this product, €1.22 per l",
    );
    expect(accessibleName(butter)).toBe(
      "Test butter 500 g, needs approval, over limit, €8.40 per kg",
    );
    expect(accessibleName(whipping)).toBe(
      "Product prod_test_whipping_cream, not offered, not available",
    );
  });

  test("a row whose pre-check did not answer is not shown as automatic", async () => {
    const line = first((await fixture("offers")).offers);
    const unchecked = { ...line, precheck: null };
    expect(shortReason(unchecked)).toBe("Not checked");
    expect(explain(unchecked)).toContain("checked again when it is placed");
  });

  test("a pre-check that asks for approval or rejects without a reason never shows the check", async () => {
    const line = first((await fixture("offers")).offers);
    for (const [decision, reason, approval, sentence] of [
      ["needs_approval", "Needs approval", "Needed", "Needs your approval."],
      ["rejected", "Would be rejected", "Would be rejected", "Would be rejected."],
    ] as const) {
      const bare = { ...line, precheck: { decision, reasons: [] } };
      const row = first(offeredRows({ offers: [bare], omitted: [] }));
      expect([row.status, row.reason]).toEqual(["attention", reason]);
      expect(Object.fromEntries(details(bare))["Approval"]).toBe(approval);
      expect(explain(bare)).toBe(sentence);
    }
  });

  test("a late or partial offer says what differs, not only that availability changed", async () => {
    const data = await fixture("offers");
    const cheese = lineOf(data, "prod_test_cheese_slices");
    expect(cheese.precheck).toEqual({
      decision: "needs_approval",
      reasons: ["AVAILABILITY_DIFFERS"],
    });
    expect(shortReason(cheese)).toBe("2 days late");
    expect(explain(cheese)).toBe(
      "Needs your approval: arrives Wed 25 Nov, 2 days late for the request.",
    );
    const milk = first((await fixture("substitutes")).offers);
    expect(shortReason(milk)).toBe("64 of 80 l");
    expect(explain(milk)).toBe("Needs your approval: only 64 of 80 l can be delivered.");
    // Whole and on time, the reason code's own words remain.
    const whole = { ...milk, claims: { ...milk.claims, shortfall: null } };
    expect(shortReason(whole)).toBe("Availability changed");
  });

  test("an automatic product claims no more than itself; the note says the order is checked again", async () => {
    const data = await fixture("offers");
    const milk = first(offeredRows(data));
    expect(explain(milk.pick)).toBe("No approval needed for this product.");
    expect(Object.fromEntries(details(milk.pick))["Approval"]).toBe("Not needed for this product");
    expect(orderNote(rowsOf(data), null)).toBe(
      "Each product is checked on its own. The whole order is checked again when it is placed.",
    );
  });

  test("the row names its own amount over the limit, the note the whole order's", async () => {
    const data = await fixture("offers");
    const butter = named(data, BUTTER);
    // Butter alone is 1,714.10 gross against a 1,700 limit, as its own pre-check measured;
    // the picks add up to 1,936.01.
    const output = visible(
      renderOfferComparison(data, inHost({ open: openAt(butter.key) }), undefined, 1700),
    );
    expect(output).toContain(
      "Needs your approval: €14.10 over your order limit. Only 179 of 200 kg can be delivered.",
    );
    expect(output).not.toContain("€236.01 over your order limit.");
    expect(output).toContain("Together €236.01 over your €1,700 order limit");
    const unknown = visible(renderOfferComparison(data, inHost({ open: openAt(butter.key) })));
    expect(unknown).toContain(
      "Needs your approval: the order total is above the mandate's spending limit.",
    );
  });

  test("under the limit no amount over it is named, never a negative one", async () => {
    const data = await fixture("offers");
    const butter = named(data, BUTTER);
    const output = visible(
      renderOfferComparison(data, inHost({ open: openAt(butter.key) }), undefined, 5000),
    );
    expect(output).not.toContain("over your order limit.");
    expect(output).not.toMatch(/€-/);
    expect(orderNote(rowsOf(data), 5000)).toBe(
      "Each product is checked on its own. The whole order is checked again when it is placed.",
    );
  });

  test("only an offer over the limit itself names an amount over it", async () => {
    const data = await fixture("offers");
    const unsalted = lineOf(data, "prod_test_butter_unsalted");
    expect(explain(unsalted, 100)).toBe(
      "Needs your approval: the order includes a substitute product.",
    );
  });

  test("picks that would be rejected are left out of the order total, and the note says so", async () => {
    const data = await fixture("offers");
    const offers = data.offers.map((o) =>
      o.offerId === "off_test_3"
        ? { ...o, precheck: { decision: "rejected" as const, reasons: [] } }
        : o,
    );
    // Without butter the picks add up to 221.91, under the limit.
    expect(orderNote(rowsOf({ ...data, offers }), 200)).toBe(
      "Together €21.91 over your €200 order limit, so the order needs your approval. 1 product would be rejected and is not counted. The whole order is checked again when it is placed.",
    );
  });

  test("only the open product shows its explanation, after its own row", async () => {
    const data = await fixture("offers");
    const butter = named(data, BUTTER);
    const output = visible(renderOfferComparison(data, inHost({ open: openAt(butter.key) })));
    expect(output).toContain("Other options (1)");
    expect(output.indexOf("Needs your approval")).toBeGreaterThan(output.indexOf(BUTTER));
    expect(output.indexOf("Needs your approval")).toBeLessThan(
      output.indexOf("Test cheese slices 1 kg"),
    );
    expect(visible(renderOfferComparison(data))).not.toContain("Needs your approval");
  });

  test("Details and Other options say whether they are open", async () => {
    const data = await fixture("offers");
    const butter = named(data, BUTTER);
    const output = text(
      renderOfferComparison(data, inHost({ open: openAt(butter.key, "options") })),
    );
    expect(output).toMatch(/aria-expanded="?false"?[^>]*>\s*Details/);
    expect(output).toMatch(/aria-expanded="?true"?[^>]*>\s*Other options \(1\)/);
  });
});

describe("substitutes", () => {
  test("show the shortfall, the rank in words and the product they replace", async () => {
    const data = await fixture("substitutes");
    const row = first(offeredRows(data));
    expect(row.name).toBe("Test milk 1 l");
    expect(row.reason).toBe("64 of 80 l");
    expect(row.options.map((o) => [o.line.claims.product.name, o.action, o.reason])).toEqual([
      ["Test milk 1 l", "pick", "64 of 80 l"],
      ["Test organic milk 1 l", "use", "Best substitute"],
      ["Test farm milk 1 l", "use", "Better substitute"],
    ]);
    const output = visible(
      renderOfferComparison(data, inHost({ open: openAt(row.key, "options") })),
    );
    expect(output).toContain("Needs your approval: only 64 of 80 l can be delivered.");
    expect(output).toContain("Pick");
    expect(output).toContain("Best substitute");
    expect(output).toContain("Ask for something else");
  });

  test("an option shows how it differs from the product it replaces", async () => {
    const butter = named(await fixture("offers"), BUTTER);
    expect(butter.options.map((o) => o.differs)).toEqual([null, "€0.20/kg dearer"]);
    const milk = first(offeredRows(await fixture("substitutes")));
    expect(milk.options.map((o) => o.differs)).toEqual([
      null,
      "−2 pts reliability",
      "−7 pts reliability · €0.10/L dearer",
    ]);
  });

  test("a difference that rounds to nothing is not shown", async () => {
    const data = await fixture("substitutes");
    const organic = data.offers[1];
    if (organic?.comparison == null) throw new Error("Expected a compared substitute");
    const tiny = {
      ...organic,
      comparison: { ...organic.comparison, reliabilityDelta: 0.004, pricePerStdUnitDelta: 0.004 },
    };
    const row = first(offeredRows({ ...data, offers: [first(data.offers), tiny] }));
    expect(row.options[1]?.differs).toBeNull();
  });

  test("an option's name opens its own details", async () => {
    const data = await fixture("offers");
    const butter = named(data, BUTTER);
    const unsalted = lineOf(data, "prod_test_butter_unsalted");
    const ui = show(inHost({ open: openAt(butter.key, "options") }), "details", unsalted.offerId);
    const output = visible(renderOfferComparison(data, ui));
    expect(output).toContain("Test butter 500 g, unsalted");
    expect(output).toContain("Reliability 99%");
  });

  test("a substitute covers the shortfall of its own line, not a whole line", async () => {
    const data = await fixture("substitutes");
    const [milk, organic] = data.offers;
    if (milk === undefined || organic === undefined) throw new Error("Expected offers");
    const whole = { ...milk, offerId: "off_test_9", claims: { ...milk.claims, shortfall: null } };
    // Two lines of milk; only the second is short, so the substitute belongs to it.
    const rows = offeredRows({ offers: [whole, milk, organic], omitted: [] });
    expect(rows.map((r) => [r.pick.offerId, r.options.length])).toEqual([
      ["off_test_9", 1],
      [milk.offerId, 2],
    ]);
  });

  test("an option that would be rejected has no Use", async () => {
    const data = await fixture("substitutes");
    const [original, organic, farm] = data.offers;
    if (original === undefined || organic === undefined || farm === undefined)
      throw new Error("Expected offers");
    const rejected = { ...farm, precheck: { decision: "rejected" as const, reasons: [] } };
    const row = first(offeredRows({ ...data, offers: [original, organic, rejected] }));
    expect(row.options.map((o) => [o.line.offerId, o.action])).toEqual([
      [original.offerId, "pick"],
      [organic.offerId, "use"],
      [farm.offerId, null],
    ]);
  });

  test("outside a chat there is no Use and no Ask for something else", async () => {
    const data = await fixture("substitutes");
    const row = first(offeredRows(data));
    const output = visible(
      renderOfferComparison(data, { ...closed, open: openAt(row.key, "options") }),
    );
    expect(output).not.toMatch(/\bUse\b/);
    expect(output).not.toContain("Ask for something else");
  });

  test("the chat text of a Use asks the substitute for the missing amount only", async () => {
    const data = await fixture("substitutes");
    const row = first(offeredRows(data));
    const organic = row.options[1];
    if (organic === undefined) throw new Error("Expected a second option");
    expect(useText(row, organic)).toBe(
      "For the missing 16 l of Test milk 1 l, use Test organic milk 1 l.",
    );
    const whole = {
      ...row,
      pick: { ...row.pick, claims: { ...row.pick.claims, shortfall: null } },
    };
    expect(useText(whole, organic)).toBe("For Test milk 1 l, use Test organic milk 1 l instead.");
    expect(retryText(row)).toBe("Check the offer for Test milk 1 l again.");
  });
});

describe("one row per requested line", () => {
  test("two lines of one product are two rows, each with its own substitutes", async () => {
    const data = await fixture("substitutes");
    const [milk, organic, farm] = data.offers;
    if (milk === undefined || organic === undefined || farm === undefined)
      throw new Error("Expected offers");
    const again = { ...milk, offerId: "off_test_7" };
    const organic2 = { ...organic, offerId: "off_test_8" };
    // get-offers lists the originals first, then one block per short original, best first.
    const rows = offeredRows({ offers: [milk, again, organic, farm, organic2], omitted: [] });
    expect(rows.map((r) => [r.pick.offerId, r.options.length])).toEqual([
      [milk.offerId, 3],
      ["off_test_7", 2],
    ]);
    // Each row opens on its own.
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    // Two blocks that each hold only a best substitute are still two blocks.
    const twoBest = offeredRows({ offers: [milk, again, organic, organic2], omitted: [] });
    expect(twoBest.map((r) => r.options.map((o) => o.line.offerId))).toEqual([
      [milk.offerId, organic.offerId],
      ["off_test_7", "off_test_8"],
    ]);
  });

  test("a line left out is kept even when another line of the same product is offered", async () => {
    const data = await fixture("substitutes");
    const milk = first(data.offers);
    const rows = rowsOf({
      offers: [milk],
      omitted: [
        { productId: milk.claims.productId, reason: "INVALID_QUANTITY", detail: "Not a lot size." },
      ],
    });
    expect(rows.map((r) => [r.kind, r.reason])).toEqual([
      ["offered", "64 of 80 l"],
      ["omitted", "Invalid amount"],
    ]);
  });

  test("a product offered only through a substitute keeps why it was left out", async () => {
    const data = await fixture("substitutes");
    const organic = data.offers.find((o) => o.rank === "best");
    if (organic === undefined) throw new Error("Expected a best substitute");
    const rows = rowsOf({
      offers: [organic],
      omitted: [{ productId: "prod_test_milk", reason: "INSUFFICIENT_STOCK", detail: "None." }],
    });
    expect(rows).toHaveLength(1);
    const row = first(rows);
    expect(row.name).toBe("Product prod_test_milk");
    expect([row.status, row.reason]).toEqual(["attention", "Not available"]);
    expect(accessibleName(row)).toContain("only a substitute is offered");
    // With several substitutes, the best one is the pick, wherever it is listed.
    const farm = data.offers.find((o) => o.rank === "better");
    if (farm === undefined) throw new Error("Expected a better substitute");
    const several = first(offeredRows({ offers: [farm, organic], omitted: [] }));
    expect(several.pick.offerId).toBe(organic.offerId);
  });
});

describe("steering", () => {
  test("a link shows Asked once the chat took it, and the others are free again", () => {
    const asking = sending(inHost({}), "off_a", "row1");
    if (asking === null) throw new Error("Expected the message to start");
    expect(linkState("off_a", asking)).toBe("sending");
    expect(linkState("off_b", asking)).toBe("disabled");
    expect(sending(asking, "off_b", "row1")).toBeNull();
    const done = sent(asking);
    expect(linkState("off_a", done)).toBe("asked");
    expect(linkState("off_b", done)).toBe("enabled");
    expect(sending(done, "off_a", "row1")).toBeNull();
  });

  test("a message the chat did not take frees its link and shows why under its product", async () => {
    const data = await fixture("offers");
    const butter = named(data, BUTTER);
    const unsalted = butter.options[1];
    if (unsalted === undefined) throw new Error("Expected a second option");
    const asking = sending(
      inHost({ open: openAt(butter.key, "options") }),
      unsalted.line.offerId,
      butter.key,
    );
    if (asking === null) throw new Error("Expected the message to start");
    // Another product is opened while the message is on its way, then the send fails.
    const milkKey = first(rowsOf(data)).key;
    const lost = failed(toggle(asking, milkKey));
    expect(lost.error).toEqual({ key: butter.key });
    expect(linkState(unsalted.line.offerId, lost)).toBe("enabled");
    const output = visible(renderOfferComparison(data, lost));
    expect(count(output, SEND_FAILED)).toBe(1);
    expect(output.indexOf(SEND_FAILED)).toBeGreaterThan(output.indexOf(BUTTER));
    expect(output.indexOf(SEND_FAILED)).toBeLessThan(output.indexOf("Test cheese slices 1 kg"));
    expect(output).not.toContain("Asked ✓");
  });

  test("after a failed send the status never says it was sent", async () => {
    const data = await fixture("substitutes");
    const row = first(offeredRows(data));
    const [, organic, farm] = row.options;
    if (organic === undefined || farm === undefined) throw new Error("Expected options");
    const opened = sending(
      inHost({ open: openAt(row.key, "options") }),
      organic.line.offerId,
      row.key,
    );
    if (opened === null) throw new Error("Expected the message to start");
    const done = sent(opened);
    expect(steerStatus(row, done)).toBe("sent");
    const second = sending(done, farm.line.offerId, row.key);
    if (second === null) throw new Error("Expected the message to start");
    expect(steerStatus(row, second)).toBe("sending");
    expect(steerStatus(row, failed(second))).toBeNull();
  });

  test("Asked replaces the label on the same Use button", async () => {
    const data = await fixture("substitutes");
    const row = first(offeredRows(data));
    const organic = row.options[1];
    if (organic === undefined) throw new Error("Expected a second option");
    const asked = inHost({ open: openAt(row.key, "options"), asked: [organic.line.offerId] });
    const output = text(renderOfferComparison(data, asked));
    expect(output).toMatch(/aria-disabled="?true"?[^>]*>\s*<span\s[^]*?<\/span\s*>Asked ✓/);
    expect(visible(renderOfferComparison(data, asked))).toMatch(/\bUse\b/);
  });

  test("Try again shows Asked once sent, so it is not sent twice", async () => {
    const line = first((await fixture("offers")).offers);
    const data = { offers: [{ ...line, precheck: null }], omitted: [] };
    const row = first(offeredRows(data));
    const retry = `retry:${row.key}`;
    const asking = sending(inHost({ open: openAt(row.key) }), retry, row.key);
    if (asking === null) throw new Error("Expected the message to start");
    const done = sent(asking);
    expect(visible(renderOfferComparison(data, done))).toContain("Asked ✓");
    expect(sending(done, retry, row.key)).toBeNull();
  });

  test("Try again shows only for an unanswered pre-check, and only in a chat", async () => {
    const data = await fixture("offers");
    const line = first(data.offers);
    const unchecked = { offers: [{ ...line, precheck: null }], omitted: [] };
    const key = first(offeredRows(unchecked)).key;
    expect(visible(renderOfferComparison(unchecked, inHost({ open: openAt(key) })))).toContain(
      "Try again",
    );
    expect(
      visible(renderOfferComparison(unchecked, { ...closed, open: openAt(key) })),
    ).not.toContain("Try again");
    const checked = { offers: [line], omitted: [] };
    expect(visible(renderOfferComparison(checked, inHost({ open: openAt(key) })))).not.toContain(
      "Try again",
    );
  });

  test("one product is open at a time, and a panel closes when asked for again", () => {
    const one = toggle(closed, "a");
    expect(one.open).toEqual({ key: "a", panel: "summary", offerId: null });
    const options = show(one, "options");
    expect(options.open?.panel).toBe("options");
    expect(show(options, "options").open?.panel).toBe("summary");
    expect(toggle(options, "b").open).toEqual({ key: "b", panel: "summary", offerId: null });
    expect(toggle(one, "a").open).toBeNull();
    expect(show(closed, "details")).toBe(closed);
  });
});

describe("products left out", () => {
  test("a result with no offers lists each product with its reason", async () => {
    const data = await fixture("empty");
    const output = visible(renderOfferComparison(data));
    expect(output).toContain("None of the products can be offered.");
    expect(rowsOf(data).map((r) => [r.status, r.reason])).toEqual([
      ["none", "Not in catalogue"],
      ["none", "Not for sale"],
      ["none", "Not available"],
    ]);
    for (const reason of ["Not in catalogue", "Not for sale", "Not available"])
      expect(output).toContain(reason);
  });

  test("an opened product that was left out says why in a sentence", async () => {
    const data = await fixture("empty");
    const output = visible(renderOfferComparison(data, inHost({ open: openAt("omitted:1") })));
    expect(output).toContain("The product is blocked from sale.");
  });
});

describe("language", () => {
  test("in Finnish a row, the open sentence and the links read in Finnish", async () => {
    const data = await fixture("offers");
    const butter = named(data, BUTTER);
    setLang("fi");
    try {
      const row = first(rowsOf(data).filter((r) => r.name === BUTTER));
      expect(row.reason).toBe("Yli rajan");
      expect(plain(row.kind === "offered" ? row.price?.shown : undefined)).toBe("8,40 €/kg");
      const output = visible(
        renderOfferComparison(data, inHost({ open: openAt(butter.key) }), undefined, 1700),
      );
      expect(output).toContain("5 tuotetta");
      expect(output).toContain("Vaatii hyväksyntäsi: 14,10 € yli tilausrajasi.");
      expect(output).toContain("Tiedot");
      expect(output).toContain("Muut vaihtoehdot (1)");
      expect(output).not.toContain("Needs your approval");
      const milk = Object.fromEntries(details(lineOf(data, "prod_test_milk_drink")));
      expect(plain(milk["Toimitusvarmuus"])).toBe("97 %");
      expect(milk["Toimitus"]).not.toMatch(/Mon|Nov/);
      const subs = first(offeredRows(await fixture("substitutes")));
      const organic = subs.options[1];
      if (organic === undefined) throw new Error("Expected a second option");
      expect(useText(subs, organic)).toBe(
        "Täydennä tuotteen Test milk 1 l puuttuvat 16 l tuotteella Test organic milk 1 l.",
      );
    } finally {
      setLang("en");
    }
  });
});

describe("details", () => {
  test("label CO2 as the product-group average and show No data, never 0, when missing", async () => {
    const data = await fixture("offers");
    const milk = Object.fromEntries(details(lineOf(data, "prod_test_milk_drink")));
    expect(milk["CO2"]).toBe("1.1 (product-group average, kg CO2-eq/kg)");
    const butter = Object.fromEntries(details(lineOf(data, "prod_test_butter")));
    expect(butter["CO2"]).toBe("No data");
    expect(butter["Reliability"]).toBe("No data");
    expect(butter["Origin"]).toBe("No data");
  });

  test("an empty origin reads No data", async () => {
    const line = lineOf(await fixture("offers"), "prod_test_milk_drink");
    const blank = {
      ...line,
      claims: { ...line.claims, product: { ...line.claims.product, countryOfOrigin: " " } },
    };
    expect(Object.fromEntries(details(blank))["Origin"]).toBe("No data");
  });

  test("the gross total says when it includes deposits", async () => {
    const line = lineOf(await fixture("offers"), "prod_test_milk_drink");
    // 58.56 net + 14 % VAT = 66.76, plus 4.80 deposits = 71.56 gross.
    const withDeposits = {
      ...line,
      claims: { ...line.claims, deposits: 4.8, total: { net: 58.56, gross: 71.56 } },
    };
    const facts = Object.fromEntries(details(withDeposits));
    expect(facts["Total"]).toBe("€58.56 net, €71.56 incl. VAT and deposits");
    expect(facts["Deposits"]).toBe("€4.80, in the total");
    const unknown = { ...line, claims: { ...line.claims, depositsIncluded: false } };
    expect(Object.fromEntries(details(unknown))["Deposits"]).toBe(
      "Not given by the wholesaler, not in the total",
    );
  });
});

test("loading shows the branded frame with three placeholder rows", () => {
  const output = text(renderLoading());
  expect(visible(renderLoading())).toContain("Getting offers…");
  expect(count(output, "skeleton shimmer")).toBe(3);
});

describe("the order limit", () => {
  test("is the mandate's limit only for the mandate the offers were made under", async () => {
    const { offers } = await fixture("offers");
    const { storedMandate } = fixtures;
    const active = {
      ...storedMandate,
      mandate: {
        ...storedMandate.mandate,
        mandateId: "mnd_test_1",
        version: 1,
        limits: {
          ...storedMandate.mandate.limits,
          maxOrderTotal: { value: 1700, currency: "EUR" as const, basis: "gross" as const },
        },
      },
    };
    expect(limitFor(offers, active)).toBe(1700);
    expect(limitFor(offers, { ...active, mandate: { ...active.mandate, version: 2 } })).toBeNull();
    expect(
      limitFor(offers, { ...active, mandate: { ...active.mandate, mandateId: "mnd_other" } }),
    ).toBeNull();
    expect(limitFor(offers, { ...active, status: "revoked" })).toBeNull();
    expect(limitFor(offers, null)).toBeNull();
  });
});
