import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Order, OrderSchema, REASON_TEXT, VIEWS } from "@app/contract";
import { html } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { ApprovalCard } from "../views/approval-card/approval-card.ts";
import { defineApprovalView } from "../views/approval-card/approval-view.ts";
import { defineMandateSettings } from "../views/mandate-settings/mandate-settings.ts";
import { defineOfferComparison } from "../views/offer-comparison/offer-comparison.ts";
import { defineOrderTimeline } from "../views/order-timeline/order-timeline.ts";
import { defineSearchResults } from "../views/search-results/search-results.ts";
import { parseResult, type ViewName, viewEntry } from "./bridge.ts";
import { markup, renderProblems } from "./template-text.ts";
import { ViewElement } from "./view-element.ts";

// Every view renders every fixture in `contexts/views/fixtures/<view>/`. A new fixture is
// the way to add view coverage: it gets these checks without a new test.

const TAGS: Record<ViewName, string> = {
  "approval-card": "tt-approval-view",
  "mandate-settings": "tt-mandate-settings",
  "offer-comparison": "tt-offer-comparison",
  "order-timeline": "tt-order-timeline",
  "search-results": "tt-search-results",
};
defineApprovalView();
defineMandateSettings();
defineOfferComparison();
defineOrderTimeline();
defineSearchResults();

const fixtures = resolve(import.meta.dir, "../../fixtures");
const fixture = (view: string, name: string): Promise<unknown> =>
  Bun.file(resolve(fixtures, view, name)).json();

/** The view element of `view`, as the page creates it. */
function element(view: ViewName) {
  const constructor = customElements.get(TAGS[view]);
  const created = constructor === undefined ? undefined : new constructor();
  if (!(created instanceof ViewElement)) throw new Error(`${TAGS[view]} is not a view element.`);
  return created;
}

/**
 * Renders `render` with the browser globals a view reads while it renders. The mandate
 * error state builds its plain page link from `document` and `location`.
 */
function withPage<T>(render: () => T): T {
  const page = {
    document: { querySelector: () => null },
    location: { origin: "http://views.test" },
  };
  const added = Object.keys(page).filter((key) => !(key in globalThis));
  Object.assign(globalThis, Object.fromEntries(added.map((key) => [key, Reflect.get(page, key)])));
  try {
    return render();
  } finally {
    for (const key of added) Reflect.deleteProperty(globalThis, key);
  }
}

/** The approval card the view shows for one order, as the host opens it. */
const card = (order: Order) => {
  const shown = new ApprovalCard();
  shown.order = order;
  shown.canAsk = true;
  return shown.render();
};

for (const entry of VIEWS) {
  describe(entry.view, () => {
    for (const name of readdirSync(resolve(fixtures, entry.view)).toSorted()) {
      test(`${name} renders without broken values or repeated sentences`, async () => {
        const view = element(entry.view);
        const state = parseResult(entry, await fixture(entry.view, name));
        Reflect.set(view, "state", state);
        const rendered = withPage(() => view.render());
        expect(renderProblems(rendered)).toEqual([]);
        if (entry.view !== "approval-card" || state.kind !== "done") return;

        // One order opens as its card; a list shows a review button for each order.
        const orders = OrderSchema.array().parse(
          "orders" in state.data ? state.data.orders : [state.data],
        );
        if (orders.length > 1)
          expect(markup(rendered).match(/<button\b/g)?.length).toBe(orders.length);
        for (const order of orders) {
          const shown = card(order);
          expect(renderProblems(shown)).toEqual([]);
          if (order.status === "pending_approval") {
            expect(markup(shown)).toContain('part="button approve"');
            expect(markup(shown)).toContain('part="button reject"');
          }
        }
      });
    }
  });
}

describe("the render checks", () => {
  test("find values that render as broken text", () => {
    expect(renderProblems(html`<p>${"undefined"} kg</p>`)).toEqual(["shows undefined"]);
    expect(renderProblems(html`<p>${Number.NaN} kg</p>`)).toEqual(["shows NaN"]);
    expect(renderProblems(html`<p>${{ amount: 1 }}</p>`)).toEqual(["shows [object Object]"]);
    expect(renderProblems(html`<p title=${`undefined`}>Total</p>`)).toEqual(["shows undefined"]);
  });

  test("skip what Lit renders as no text", () => {
    const order = { orderId: "ord_1" };
    expect(
      renderProblems(
        html`<p>${undefined}${null}${false}</p>
          <tt-card .order=${order} ?busy=${false} @tt-decide=${() => order}></tt-card>
          <span>${unsafeSVG("<svg></svg>")}</span>`,
      ),
    ).toEqual([]);
  });

  test("find a sentence repeated in one row or outside rows, not across rows", () => {
    const twice = "The price changed since the offer was made.";
    expect(
      renderProblems(
        html`<li>
          <p>${twice}</p>
          <span>Rule</span>
          <p>${twice}</p>
        </li>`,
      ),
    ).toEqual([`repeats "${twice}"`]);
    expect(
      renderProblems(
        html`<section><p>${twice}</p></section>
          <p>${twice}</p>`,
      ),
    ).toEqual([`repeats "${twice}"`]);
    expect(
      renderProblems(
        html`<ul>
          <li><p>${twice}</p></li>
          <li><p>${twice}</p></li>
        </ul>`,
      ),
    ).toEqual([]);
    expect(
      renderProblems(
        html`<p>Order no.</p>
          <p>Order no.</p>`,
      ),
    ).toEqual([]);
  });
});

// The server stores the reason's text as the event detail too (#168).
test("a timeline event whose detail is its reason text shows it once (#168)", async () => {
  const order = OrderSchema.parse(await fixture("order-timeline", "done.json"));
  const audit = order.audit.map((event) =>
    event.reason === undefined ? event : { ...event, detail: REASON_TEXT[event.reason] },
  );
  const view = element("order-timeline");
  Reflect.set(view, "state", parseResult(viewEntry("order-timeline"), { ...order, audit }));
  expect(renderProblems(view.render())).toEqual([]);
});
