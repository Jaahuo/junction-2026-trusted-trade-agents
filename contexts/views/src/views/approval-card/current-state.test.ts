import { expect, test } from "bun:test";
import { type Order, OrderSchema } from "@app/contract";
import declinedStop from "../../../fixtures/approval-card/declined-stop.json";
import pendingFixture from "../../../fixtures/approval-card/pending.json";
import placedFixture from "../../../fixtures/approval-card/placed.json";
import { fixtureSource, type Source } from "../../shared/bridge.ts";
import { ApprovalCard } from "./approval-card.ts";
import { isNewer, readCurrent, withCurrent } from "./current-state.ts";
import { clickHandler, markup } from "./template-walk.ts";

type Template = { strings: readonly string[]; values: unknown[] };
const isTemplate = (value: unknown): value is Template =>
  typeof value === "object" && value !== null && "strings" in value && "values" in value;

/** The value bound right after `marker` in the template tree, or undefined. */
const boundAfter = (value: unknown, marker: string): unknown => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = boundAfter(item, marker);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isTemplate(value)) return undefined;
  const index = value.strings.findIndex((part) => part.endsWith(marker));
  if (index !== -1) return value.values[index];
  for (const nested of value.values) {
    const found = boundAfter(nested, marker);
    if (found !== undefined) return found;
  }
  return undefined;
};

const pending = OrderSchema.parse(pendingFixture);
// The same order as the server has it after each change.
const placed: Order = { ...OrderSchema.parse(placedFixture), orderId: pending.orderId };
const declined: Order = { ...OrderSchema.parse(declinedStop), orderId: pending.orderId };
const edited: Order = { ...pending, proposalVersion: pending.proposalVersion + 1 };

/** A chat source whose tool result is `shown` and whose server answers `server` (or fails). */
const chat = (shown: Order, server: Order | Error): Source => ({
  load: async () => shown,
  call: async (tool, args) => {
    if (tool !== "get_order_status" || args["orderId"] !== shown.orderId)
      throw new Error(`unexpected ${tool}`);
    if (server instanceof Error) throw server;
    return server;
  },
  message: async () => {},
});

const current = async (shown: Order, server: Order | Error) => {
  const read = await readCurrent(chat(shown, server), shown);
  return { data: withCurrent(shown, read.current), unread: read.unread };
};

test("a card loaded from a pending tool result shows the order the server has placed since", async () => {
  const { data, unread } = await current(pending, placed);
  expect(data).toEqual(placed);
  expect(unread.size).toBe(0);
  const card = new ApprovalCard();
  card.order = placed;
  expect(markup(card.render())).not.toContain('part="button approve"');
});

test("a card shows the order declined since, for example from another tab, when it reads again", async () => {
  expect((await current(pending, declined)).data).toEqual(declined);
});

test("a pending order edited elsewhere shows its newest proposal", async () => {
  expect((await current(pending, edited)).data).toEqual(edited);
});

test("an older replayed tool result never turns a decided order back into pending", () => {
  expect(isNewer(pending, placed)).toBe(false);
  expect(withCurrent(placed, [pending])).toEqual(placed);
  expect(withCurrent(edited, [pending])).toEqual(edited);
  expect(withCurrent({ orders: [placed] }, [pending])).toEqual({ orders: [placed] });
});

test("an order whose current state cannot be read keeps its tool result and locks the decision", async () => {
  const { data, unread } = await current(pending, new Error("UPSTREAM_FAILED: down"));
  expect(data).toEqual(pending);
  expect([...unread]).toEqual([pending.orderId]);

  const card = new ApprovalCard();
  card.order = pending;
  card.locked = true;
  const sent: string[] = [];
  card.dispatchEvent = (event: Event) => {
    sent.push(event.type);
    return true;
  };
  expect(boundAfter(card.render(), 'part="actions" ?inert=')).toBe(true);
  card.locked = false;
  expect(boundAfter(card.render(), 'part="actions" ?inert=')).toBe(false);
  card.locked = true;
  clickHandler(card.render(), 'part="button approve"')?.();
  clickHandler(card.render(), 'part="button reject"')?.();
  expect(sent).toEqual([]);
});

test("the harness answers the current state of an order, including a decision made on the card", async () => {
  const source = fixtureSource({ result: pending }, () => "2026-11-14T10:00:00.000Z");
  expect((await readCurrent(source, pending)).current).toEqual([pending]);
  await source.call("decide_approval", {
    orderId: pending.orderId,
    decision: "approve",
    proposalVersion: pending.proposalVersion,
  });
  const after = await readCurrent(source, pending);
  expect(after.current[0]?.status).not.toBe("pending_approval");
  expect(after.unread.size).toBe(0);
});
