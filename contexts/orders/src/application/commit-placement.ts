import { type AuditEvent, REASON_TEXT, type ReasonCode } from "@app/contract";
import type { OrderTx, PaymentPort, StoredOrder } from "./ports.ts";

const serverEvent = (
  at: string,
  event: AuditEvent["event"],
  extra: Omit<AuditEvent, "at" | "actor" | "event"> = {},
): AuditEvent => ({ at, actor: "server", event, ...extra });

const rejectWith = (
  order: StoredOrder,
  reason: ReasonCode,
  at: string,
  detail: string,
): StoredOrder => ({
  ...order,
  status: "rejected",
  reasons: [...order.reasons, reason],
  audit: [
    ...order.audit,
    serverEvent(at, "check_failed", { reason, detail }),
    serverEvent(at, "rejected", { reason }),
  ],
});

/**
 * Every move to `placed` goes through here (SPEC-010), inside the caller's transaction and customer lock.
 * Invoice: the total must fit the remaining credit. Pay-on-order: the payment port authorizes first.
 * Returns the order with its final status and audit; the caller writes it. Placed lines add history rows.
 * Re-validation of the offers is not part of the first build.
 */
export const commitPlacement = async (input: {
  tx: OrderTx;
  order: StoredOrder;
  creditLimit: number | null;
  payment: PaymentPort;
  now: Date;
}): Promise<StoredOrder> => {
  const { tx, order, creditLimit, payment, now } = input;
  const at = now.toISOString();
  let audit = order.audit;

  if (order.paymentTerms === "invoice" && creditLimit !== null) {
    const remaining =
      Math.round((creditLimit - (await tx.placedInvoiceGross(order.customer))) * 100) / 100;
    if (order.total.gross > remaining)
      return rejectWith(
        order,
        "CREDIT_LIMIT",
        at,
        `${order.total.gross.toFixed(2)} EUR is over the remaining ${remaining.toFixed(2)} EUR credit`,
      );
  }

  if (order.paymentTerms === "pay_on_order") {
    const authorized = await payment.authorize(order);
    if (!authorized.ok) {
      return {
        ...order,
        status: "rejected",
        reasons: [...order.reasons, "PAYMENT_FAILED"],
        audit: [
          ...audit,
          serverEvent(at, "payment_failed", {
            reason: "PAYMENT_FAILED",
            detail: REASON_TEXT.PAYMENT_FAILED,
          }),
          serverEvent(at, "rejected", { reason: "PAYMENT_FAILED" }),
        ],
      };
    }
    audit = [...audit, serverEvent(at, "payment_authorized")];
  }

  await tx.addHistory(
    order.customer,
    order.lines.map((line) => ({
      productId: line.claims.productId,
      quantity: line.claims.quantity,
    })),
    now,
  );
  return { ...order, status: "placed", audit: [...audit, serverEvent(at, "placed")] };
};
