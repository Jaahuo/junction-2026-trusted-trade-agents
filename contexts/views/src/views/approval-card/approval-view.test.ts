import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { OrderSchema } from "@app/contract";
import { setLang } from "../../shared/locale.ts";
import { ApprovalCard } from "./approval-card.ts";
import { decisionText, defineApprovalView, errorCard } from "./approval-view.ts";
import { CARD } from "./card-strings.ts";
import { day } from "./parts.ts";
import { clickHandler, handlers, markup } from "./template-walk.ts";

const fixtures = resolve(import.meta.dir, "../../../fixtures/approval-card");
const order = async (name: string) =>
  OrderSchema.parse(await Bun.file(resolve(fixtures, `${name}.json`)).json());

test("the error card names the approval page when there is one, else the open approvals", () => {
  const without = markup(errorCard(null, () => undefined, "The tool result does not match."));
  expect(without).not.toContain("approval page");
  expect(without).toContain("Open approvals");
  expect(without).toContain("/approvals");
  expect(without).not.toContain("/views/approval-card");
  expect(without).toContain("Try again in a moment.");
  expect(without).toContain("The tool result does not match.");

  const url = "https://example.test/approvals?order=ord_1";
  const withPage = markup(errorCard(url, () => undefined));
  expect(withPage).toContain("Open it on the approval page");
  expect(withPage).toContain(url);
});

test("the decision text states the outcome and the next step, without ids", async () => {
  const cases = [
    ["placed", "approved. It is placed with Valio Aimo."],
    ["awaiting-payment", "approved. It goes to Valio Aimo when the payment is confirmed."],
    ["declined-stop", "rejected. Order nothing for it"],
    ["declined-alternatives", "rejected. Look for alternatives"],
  ] as const;
  for (const [name, expected] of cases) {
    const decided = await order(name);
    const text = decisionText(decided);
    expect(text).toStartWith("Order for ");
    expect(text).toContain(expected);
    expect(text).not.toContain(decided.orderId);
  }
  const refused = { ...(await order("placed")), status: "rejected" as const };
  expect(decisionText(refused)).toContain("was not placed");
});

// Find the parent's actual Lit event binding, then connect the rendered card to it.
const binding = (
  value: unknown,
  event: string,
): ((...args: unknown[]) => Promise<void>) | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = binding(item, event);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("strings" in value) || !("values" in value))
    return undefined;
  const strings: unknown = Reflect.get(value, "strings");
  const values: unknown = Reflect.get(value, "values");
  if (!Array.isArray(strings) || !Array.isArray(values)) return undefined;
  for (const [i, part] of strings.entries()) {
    if (typeof part === "string" && part.trimEnd().endsWith(`@${event}=`)) {
      const handler: unknown = values[i];
      if (typeof handler !== "function") throw new Error(`invalid ${event} binding`);
      return async (...args: unknown[]) => {
        await Reflect.apply(handler, undefined, args);
      };
    }
  }
  return binding(values, event);
};

const render = (view: HTMLElement): unknown => {
  const method: unknown = Reflect.get(view, "render");
  if (typeof method !== "function") throw new Error("missing render method");
  return Reflect.apply(method, view, []);
};

const stringDetail = (event: Event): string => {
  if (!(event instanceof CustomEvent)) throw new Error("expected a custom event");
  const detail: unknown = event.detail;
  if (typeof detail !== "string") throw new Error("expected string event detail");
  return detail;
};

const actions = [
  { name: "limit: reduce", fixture: "pending", index: -1, limit: 1700 },
  { name: "limit: drop items", fixture: "pending", index: 0, limit: 1700 },
  { name: "limit: cheaper brands", fixture: "pending", index: 1, limit: 1700 },
  { name: "limit: lower quantities", fixture: "pending", index: 2, limit: 1700 },
  { name: "substitution: help", fixture: "pending-substitution", index: -1, limit: null },
  { name: "substitution: same brand", fixture: "pending-substitution", index: 0, limit: null },
  { name: "substitution: cheapest", fixture: "pending-substitution", index: 1, limit: null },
  { name: "substitution: wait", fixture: "pending-substitution", index: 2, limit: null },
  { name: "shortfall: help", fixture: "pending-partial", index: -1, limit: null },
  { name: "shortfall: all later", fixture: "pending-partial", index: 0, limit: null },
  { name: "shortfall: fewer packs", fixture: "pending-partial", index: 1, limit: null },
  { name: "shortfall: another product", fixture: "pending-partial", index: 2, limit: null },
  { name: "late: help", fixture: "pending-late", index: -1, limit: null },
  { name: "late: same brand", fixture: "pending-late", index: 0, limit: null },
  { name: "late: cheapest", fixture: "pending-late", index: 1, limit: null },
] as const;

for (const lang of ["en", "fi"] as const)
  for (const row of actions) {
    test(`${lang} ${row.name} rejects the held order and sends the selected request`, async () => {
      setLang(lang);
      try {
        defineApprovalView();
        const ctor = customElements.get("tt-approval-view");
        if (ctor === undefined) throw new Error("approval view not registered");
        const shown = await order(row.fixture);
        const declined = await order("declined-alternatives");
        const view = new ctor();
        const calls: { tool: string; args: Record<string, unknown> }[] = [];
        const contexts: string[] = [];
        const messages: string[] = [];
        Reflect.set(view, "source", {
          load: async () => shown,
          call: async (tool: string, args: Record<string, unknown>) => {
            calls.push({ tool, args });
            return { ...shown, status: "declined", decision: declined.decision };
          },
          context: async (text: string) => {
            contexts.push(text);
          },
          message: async (text: string) => {
            messages.push(text);
          },
        });
        Reflect.set(view, "state", { kind: "done", data: shown });
        Reflect.set(view, "orderLimit", row.limit);
        const parent = binding(render(view), "tt-ask-agent");
        if (parent === undefined) throw new Error("missing parent ask binding");
        const card = new ApprovalCard();
        card.order = shown;
        card.canAsk = true;
        card.orderLimit = row.limit;
        let sent: string | undefined;
        let pending: Promise<void> | undefined;
        card.dispatchEvent = (event: Event) => {
          sent = stringDetail(event);
          pending = parent(event);
          return true;
        };
        const rendered = card.render();
        const action =
          row.index === -1
            ? clickHandler(
                rendered,
                row.fixture === "pending" ? 'part="reduce"' : 'part="agent-help"',
              )
            : handlers(rendered, 'class="chip"', "@click=")[row.index];
        if (action === undefined) throw new Error(`missing ${row.name} action`);
        action();
        if (pending === undefined) throw new Error("action did not dispatch an event");
        await pending;
        const first = shown.lines[0]?.claims;
        if (first === undefined) throw new Error("fixture has no problem line");
        const text = CARD[lang];
        const weekday = (date: string) =>
          new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "fi-FI", { weekday: "long" }).format(
            new Date(date),
          );
        let prompt: string;
        let chips: string[];
        if (row.fixture === "pending") {
          prompt = text.reducePrompt(shown.orderId);
          chips = text.reduceChips;
        } else if (row.fixture === "pending-substitution") {
          if (first.nextDeliveryDate === null) throw new Error("missing substitution next date");
          prompt = text.findPrompt(
            first.product.name,
            text.outOfStock(day(first.nextDeliveryDate)),
          );
          chips = [text.sameBrand, text.cheapest, text.waitUntil(day(first.nextDeliveryDate))];
        } else if (row.fixture === "pending-partial") {
          if (first.shortfall === null || first.nextDeliveryDate === null)
            throw new Error("missing shortfall");
          const missing =
            first.product.perSalesUnit === null
              ? first.shortfall.value
              : Math.round(first.shortfall.value / first.product.perSalesUnit.value);
          prompt = text.shortPrompt(
            first.quantity.value,
            first.quantity.value + missing,
            first.product.name,
            weekday(first.deliveryDate),
          );
          chips = [
            text.allOnWeekday(weekday(first.nextDeliveryDate)),
            text.onlyPacks(text.packs(String(first.quantity.value))),
            text.anotherProduct,
          ];
        } else {
          prompt = text.latePrompt(
            first.product.name,
            day(first.requestedDate),
            day(first.deliveryDate),
          );
          chips = [text.sameBrand, text.cheapest];
        }
        const chip = row.index === -1 ? null : chips[row.index];
        if (row.index !== -1 && chip === undefined) throw new Error("missing expected chip");
        expect(sent).toBe(chip === null ? prompt : `${prompt} ${chip}.`);
        expect(calls).toEqual([
          {
            tool: "decide_approval",
            args: {
              orderId: shown.orderId,
              proposalVersion: shown.proposalVersion,
              decision: "reject",
              next: "alternatives",
              note: sent,
            },
          },
        ]);
        expect(contexts).toEqual(messages);
        expect(messages).toHaveLength(1);
        const message = messages[0];
        if (message === undefined || sent === undefined) throw new Error("missing message");
        expect(message).toContain(`Approver request: ${sent}`);
        expect(message).toContain("The approver REJECTED this order and asks for a NEW OFFER");
        expect(message).toContain(`${shown.total.gross.toFixed(2)} EUR`);
        expect(message).toContain(
          `Mandate order limit including VAT: ${row.limit === null ? "unknown" : `${row.limit.toFixed(2)} EUR`}`,
        );
        expect(message).toContain(`Original order request: ${shown.originalRequest ?? "unknown"}`);
        const [held, alternatives] = message.split(
          "Available alternatives (not held order lines):",
        );
        if (held === undefined || alternatives === undefined)
          throw new Error("missing separate sections");
        for (const { claims } of shown.lines) {
          expect(held).toContain(claims.product.name);
          expect(held).toContain(claims.productId);
          expect(held).toContain(`${claims.quantity.value} ${claims.quantity.unit}`);
          expect(held).toContain(claims.requestedDate);
          expect(held).toContain(claims.deliveryDate);
          expect(held).toContain(`next delivery ${claims.nextDeliveryDate ?? "unknown"}`);
          expect(held).toContain(
            `shortfall ${claims.shortfall === null ? "none" : `${claims.shortfall.value} ${claims.shortfall.unit}`}`,
          );
        }
        for (const { claims } of shown.alternatives) {
          expect(alternatives).toContain(claims.product.name);
          expect(alternatives).toContain(`replaces ${claims.replaces}`);
          expect(held).not.toContain(claims.product.name);
        }
        expect(message).toContain("get_order_status");
        expect(message).toContain("get_offers");
        expect(message).toContain("place_order");
      } finally {
        setLang("en");
      }
    });
  }

for (const lang of ["en", "fi"] as const)
  test(`${lang} discussion stays pending and a refused context cannot suppress chat; failed rejection sends nothing`, async () => {
    setLang(lang);
    try {
      defineApprovalView();
      const ctor = customElements.get("tt-approval-view");
      if (ctor === undefined) throw new Error("approval view not registered");
      const shown = await order("pending");
      const view = new ctor();
      const messages: string[] = [];
      const contexts: string[] = [];
      const calls: string[] = [];
      Reflect.set(view, "source", {
        load: async () => shown,
        call: async (tool: string) => {
          calls.push(tool);
          throw new Error("decision failed");
        },
        context: async (text: string) => {
          contexts.push(text);
          throw new Error("context refused");
        },
        message: async (text: string) => {
          messages.push(text);
        },
      });
      Reflect.set(view, "state", { kind: "done", data: shown });
      Reflect.set(view, "orderLimit", 1700);
      const rendered = render(view);
      const talk = binding(rendered, "tt-talk");
      const ask = binding(rendered, "tt-ask-agent");
      if (talk === undefined || ask === undefined) throw new Error("missing parent bindings");
      const card = new ApprovalCard();
      card.order = shown;
      card.canAsk = true;
      let pending: Promise<void> | undefined;
      card.dispatchEvent = (event: Event) => {
        stringDetail(event);
        pending = talk(event);
        return true;
      };
      const button = clickHandler(card.render(), 'part="button talk"');
      if (button === undefined) throw new Error("missing discuss button");
      button();
      if (pending === undefined) throw new Error("button did not dispatch an event");
      await pending;
      expect(calls).toEqual([]);
      expect(contexts).toEqual(messages);
      const message = messages[0];
      if (message === undefined) throw new Error("missing discussion message");
      expect(message).toContain(`Approver request: ${CARD[lang].aboutOrder(shown.orderId)}`);
      expect(message).toContain("pending approval");
      expect(message).not.toContain("REJECTED");
      expect(message).not.toContain("place_order");
      expect(message).toContain(`Gross total including VAT: ${shown.total.gross.toFixed(2)} EUR`);
      expect(message).toContain("Mandate order limit including VAT: 1700.00 EUR");
      expect(message).toContain(`Original order request: ${shown.originalRequest ?? "unknown"}`);
      for (const { claims } of shown.lines) {
        expect(message).toContain(claims.product.name);
        expect(message).toContain(`${claims.quantity.value} ${claims.quantity.unit}`);
        expect(message).toContain(claims.requestedDate);
        expect(message).toContain(claims.deliveryDate);
        expect(message).toContain(`next delivery ${claims.nextDeliveryDate ?? "unknown"}`);
      }
      await ask(new CustomEvent("tt-ask-agent", { detail: "Find another" }));
      expect(calls).toEqual(["decide_approval"]);
      expect(contexts).toHaveLength(1);
      expect(messages).toHaveLength(1);
    } finally {
      setLang("en");
    }
  });

test("decisions send rich alternative instructions but stop does not start a chat", async () => {
  defineApprovalView();
  const ctor = customElements.get("tt-approval-view");
  if (ctor === undefined) throw new Error("approval view not registered");
  const shown = await order("pending");
  for (const next of ["alternatives", "stop"] as const) {
    const decided = await order(`declined-${next}`);
    const view = new ctor();
    const contexts: string[] = [];
    const messages: string[] = [];
    Reflect.set(view, "source", {
      load: async () => shown,
      call: async () => decided,
      context: async (text: string) => {
        contexts.push(text);
      },
      message: async (text: string) => {
        messages.push(text);
      },
    });
    Reflect.set(view, "state", { kind: "done", data: shown });
    const decide = binding(render(view), "tt-decide");
    if (decide === undefined) throw new Error("missing decision binding");
    await decide(
      new CustomEvent("tt-decide", {
        detail: { decision: "reject", proposalVersion: shown.proposalVersion, next },
      }),
    );
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toContain(decided.orderId);
    expect(contexts[0]).toContain(`${decided.total.gross.toFixed(2)} EUR`);
    expect(contexts[0]).toContain(
      `Original order request: ${decided.originalRequest ?? "unknown"}`,
    );
    const first = decided.lines[0];
    if (first === undefined) throw new Error("decided fixture has no lines");
    expect(contexts[0]).toContain(first.claims.product.name);
    if (next === "alternatives") {
      expect(messages).toEqual(contexts);
      expect(messages[0]).toContain("place_order");
      expect(messages[0]).toContain("The approver REJECTED this order and asks for a NEW OFFER");
    } else {
      expect(messages).toEqual([]);
      expect(contexts[0]).not.toContain("place_order");
    }
  }
});
