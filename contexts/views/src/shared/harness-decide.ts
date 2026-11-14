import { type DecideApprovalInput, type Order, OrderSchema } from "@app/contract";

// The harness has no server, so it plays the decision locally to let a tester walk a flow:
// approve and pick place the order, reject records it, edit makes a new version of the order.
// Prices of edited lines scale with the quantity; nothing is checked again.

const total = (lines: Order["lines"]) => ({
  net: lines.reduce((sum, l) => sum + l.claims.total.net, 0),
  gross: lines.reduce((sum, l) => sum + l.claims.total.gross, 0),
});

const scaled = (line: Order["lines"][number], value: number) => {
  const factor = value / line.claims.quantity.value;
  const t = line.claims.total;
  return {
    ...line,
    claims: {
      ...line.claims,
      quantity: { ...line.claims.quantity, value },
      total: { net: t.net * factor, gross: t.gross * factor },
    },
  };
};

/** The order after `input`, as the harness shows it. */
export function harnessDecide(order: Order, input: DecideApprovalInput, at: string): Order {
  const decided = (status: Order["status"], lines = order.lines): Order => ({
    ...order,
    lines,
    offerIds: lines.map((l) => l.offerId),
    total: total(lines),
    status,
    decision: {
      action: input.decision,
      next: input.next ?? null,
      note: input.note ?? null,
      by: "approver",
      at,
    },
  });
  switch (input.decision) {
    case "reject":
      return decided(input.next === "stop" ? "rejected" : "declined");
    case "pick_alternative": {
      const pick = order.alternatives.find((a) => a.offerId === input.offerId);
      if (pick === undefined) return decided("placed");
      const replaced = order.lines.some((l) => l.claims.productId === pick.claims.replaces);
      const lines = replaced
        ? order.lines.map((l) => (l.claims.productId === pick.claims.replaces ? pick : l))
        : order.lines.map((l) => (l.claims.replaces === null ? l : pick));
      return decided("placed", lines);
    }
    case "edit": {
      const lines = order.lines.flatMap((l) => {
        const change = input.changes?.find((c) => c.productId === l.claims.productId);
        const value = change?.quantity?.value ?? l.claims.quantity.value;
        return value === 0 ? [] : [value === l.claims.quantity.value ? l : scaled(l, value)];
      });
      return OrderSchema.parse({
        ...order,
        lines,
        offerIds: lines.map((l) => l.offerId),
        total: total(lines),
        proposalVersion: order.proposalVersion + 1,
        audit: [...order.audit, { at, actor: "approver", event: "edited" }],
      });
    }
    default:
      return decided("placed");
  }
}
