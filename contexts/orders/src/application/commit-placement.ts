import { type AuditEvent, REASON_TEXT, type ReasonCode } from "@app/contract";
import { appendAudit, verifyAuditChain } from "@app/contract/server";
import { err, ok, type Result } from "@app/kernel";
import type { OrderTx, PaymentPort, ReceiptSigner, StoredOrder } from "./ports.ts";

const serverEvent = (
  at: string,
  event: AuditEvent["event"],
  extra: Omit<AuditEvent, "at" | "actor" | "event"> = {},
): AuditEvent => ({ at, actor: "server", event, ...extra });

export const appendOrderAudit = async (
  order: StoredOrder,
  events: AuditEvent[],
  initial = false,
): Promise<Result<StoredOrder, "AUDIT_INVALID">> => {
  const scope = `order:${order.orderId}`;
  if (!initial) {
    if (order.auditAnchor === undefined || order.auditAnchor.count !== order.audit.length)
      return err("AUDIT_INVALID");
    const verified = await verifyAuditChain(scope, order.audit, order.auditAnchor);
    if (!verified.ok) return err("AUDIT_INVALID");
  }
  const chained = await appendAudit(scope, initial ? [] : order.audit, events);
  if (!chained.ok) return err("AUDIT_INVALID");
  const head = chained.value[chained.value.length - 1]?.hash;
  if (head === undefined) return err("AUDIT_INVALID");
  return ok({
    ...order,
    audit: chained.value,
    auditAnchor: { hash: head, count: chained.value.length },
  });
};

export const commitPlacement = async (input: {
  tx: OrderTx;
  order: StoredOrder;
  creditLimit: number | null;
  payment: PaymentPort;
  signReceipt: ReceiptSigner;
  now: Date;
}): Promise<Result<StoredOrder, "UPSTREAM_FAILED">> => {
  const { tx, order, creditLimit, payment, signReceipt, now } = input;
  const at = now.toISOString();
  let events: AuditEvent[] = [];
  let reason: ReasonCode | undefined;
  let detail = "";

  if (order.paymentTerms === "invoice" && creditLimit !== null) {
    const remaining =
      Math.round((creditLimit - (await tx.placedInvoiceGross(order.customer))) * 100) / 100;
    if (order.total.gross > remaining) {
      reason = "CREDIT_LIMIT";
      detail = `${order.total.gross.toFixed(2)} EUR is over the remaining ${remaining.toFixed(2)} EUR credit`;
    }
  }
  if (reason === undefined && order.paymentTerms === "pay_on_order") {
    const authorized = await payment.authorize(order);
    if (!authorized.ok) {
      reason = "PAYMENT_FAILED";
      detail = REASON_TEXT.PAYMENT_FAILED;
    } else {
      events = [serverEvent(at, "payment_authorized")];
    }
  }
  if (reason !== undefined) {
    events.push(
      serverEvent(at, reason === "PAYMENT_FAILED" ? "payment_failed" : "check_failed", {
        reason,
        detail,
      }),
      serverEvent(at, "rejected", { reason }),
    );
    const chained = await appendOrderAudit(
      { ...order, status: "rejected", reasons: [...order.reasons, reason] },
      events,
    );
    return chained.ok ? ok(chained.value) : err("UPSTREAM_FAILED");
  }

  events.push(serverEvent(at, "placed"));
  const chained = await appendOrderAudit({ ...order, status: "placed" }, events);
  if (!chained.ok) return err("UPSTREAM_FAILED");
  const receipt = await signReceipt(chained.value);
  if (!receipt.ok) return err("UPSTREAM_FAILED");
  const placed = { ...chained.value, receipt: receipt.value };
  await tx.addHistory(
    order.customer,
    order.lines.map((line) => ({
      productId: line.claims.productId,
      quantity: line.claims.quantity,
    })),
    now,
  );
  return ok(placed);
};
