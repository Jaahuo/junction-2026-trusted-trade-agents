import { appendOrderAudit } from "./commit-placement.ts";
import type { OrderDeps } from "./orders.ts";
import type { OrderTx, StoredOrder } from "./ports.ts";

export const isCutoffDue = (order: StoredOrder, now: Date): boolean =>
  order.lines.some(
    ({ claims }) =>
      claims.cutoffAt !== null && new Date(claims.cutoffAt).getTime() <= now.getTime(),
  );

/** Call only while holding the customer's lock. */
export const expireCutoff = async (tx: OrderTx, order: StoredOrder, now: Date) => {
  if (order.status !== "pending_approval" || !isCutoffDue(order, now)) return "not_due" as const;
  const at = now.toISOString();
  const declined = await appendOrderAudit(
    {
      ...order,
      status: "declined",
      decision: { action: "reject", next: "alternatives", note: null, by: "server", at },
    },
    [{ at, actor: "server", event: "declined", reason: "CUTOFF_PASSED" }],
  );
  if (!declined.ok) return "audit_invalid" as const;
  if (!(await tx.decide(declined.value, order.proposalVersion)))
    throw new Error(`Order ${order.orderId} changed during cutoff`);
  return "expired" as const;
};

/** Expire pending proposals at the captured time, serialised with customer decisions. */
export const runCutoffJob = async (
  deps: Pick<OrderDeps, "store" | "now">,
  customer?: string,
): Promise<void> => {
  const now = deps.now();
  const candidates = await deps.store.expiredPending(now, customer);
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    try {
      await deps.store.withCustomerLock(candidate.customer, async (tx) => {
        const order = await tx.find(candidate.customer, candidate.orderId);
        if (
          order === null ||
          order.status !== "pending_approval" ||
          order.proposalVersion !== candidate.proposalVersion ||
          !isCutoffDue(order, now)
        )
          return;
        if ((await expireCutoff(tx, order, now)) === "audit_invalid")
          throw new Error(`Invalid audit for order ${order.orderId}`);
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Cutoff job failed");
};
