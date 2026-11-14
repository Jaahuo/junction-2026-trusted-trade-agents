import { expect, test } from "bun:test";
import { fixtures, OrderSchema } from "@app/contract";
import substitution from "../../fixtures/approval-card/pending-substitution.json";
import { HARNESS_MANDATE, harnessDecide } from "./harness-decide.ts";
import { fixtureSource } from "./bridge.ts";

const order = OrderSchema.parse(substitution);
const at = "2026-11-14T12:00:00+00:00";
const base = { orderId: order.orderId, proposalVersion: order.proposalVersion };

test("edit makes a new version with the new amounts and the removed lines gone", () => {
  const [first, second] = order.lines;
  if (first === undefined || second === undefined) throw new Error("fixture has two lines");
  const edited = harnessDecide(
    order,
    {
      ...base,
      decision: "edit",
      changes: [
        { productId: first.claims.productId, quantity: { ...first.claims.quantity, value: 12 } },
        { productId: second.claims.productId, quantity: { ...second.claims.quantity, value: 0 } },
      ],
    },
    at,
  );
  expect(edited.status).toBe("pending_approval");
  expect(edited.proposalVersion).toBe(order.proposalVersion + 1);
  expect(edited.lines).toHaveLength(order.lines.length - 1);
  expect(edited.lines[0]?.claims.total.net).toBe(first.claims.total.net * 2);
  expect(edited.audit.at(-1)?.event).toBe("edited");
});

test("pick_alternative places the order with the substitute in place of the out-of-stock line", () => {
  const pick = order.alternatives[1];
  if (pick === undefined) throw new Error("fixture has alternatives");
  const placed = harnessDecide(
    order,
    { ...base, decision: "pick_alternative", offerId: pick.offerId },
    at,
  );
  expect(placed.status).toBe("placed");
  expect(placed.lines[0]?.offerId).toBe(pick.offerId);
  expect(placed.decision?.action).toBe("pick_alternative");
});

test("reject with stop declines the order, as the server does", () => {
  const rejected = harnessDecide(order, { ...base, decision: "reject", next: "stop" }, at);
  expect(rejected.status).toBe("declined");
  expect(rejected.decision).toEqual({
    action: "reject",
    next: "stop",
    note: null,
    by: "approver",
    at,
  });
});

test("the harness source answers decide_approval and keeps the decided order", async () => {
  const source = fixtureSource({ result: order }, () => at);
  const edited = await source.call("decide_approval", {
    ...base,
    decision: "edit",
    changes: [
      { productId: order.lines[0]?.claims.productId ?? "", quantity: { value: 3, unit: "CT" } },
    ],
  });
  expect(edited).toMatchObject({ proposalVersion: order.proposalVersion + 1 });
  const approved = await source.call("decide_approval", {
    ...base,
    proposalVersion: order.proposalVersion + 1,
    decision: "approve",
  });
  expect(approved).toMatchObject({ status: "placed", proposalVersion: order.proposalVersion + 1 });
  expect(source.call("revoke_mandate", {})).rejects.toThrow("no server");
});

test("the harness keeps a registered mandate for the next read", async () => {
  const source = fixtureSource({ result: fixtures.order });
  const limits = { ...HARNESS_MANDATE.mandate.limits, substitutions: "auto" as const };
  await source.call("register_mandate", {
    limits,
    standingConstraints: HARNESS_MANDATE.mandate.standingConstraints,
  });
  expect(await source.call("get_mandate", {})).toMatchObject({
    mandate: { limits, version: HARNESS_MANDATE.mandate.version + 1 },
  });
});
