import { err, ok, type Result } from "@app/kernel";
import { SignJWT } from "jose";
import {
  OrderReceiptClaimsSchema,
  type AuditEvent,
  type Order,
  type OrderReceiptClaims,
} from "../orders.ts";
import { ALG, verifyTypedJws } from "./jws.ts";
import type { OfferKeySet, OfferSigningKey } from "./offer-token.ts";

type Anchor = { hash: string; count: number };

// Reject values that JSON would silently change or omit, including cycles and sparse arrays.
const canonical = (value: unknown, ancestors = new Set<object>()): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Not JSON");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Not JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new Error("Not JSON");
        parts.push(canonical(value[i], ancestors));
      }
      if (Object.keys(value).length !== value.length) throw new Error("Not JSON");
      return `[${parts.join(",")}]`;
    }
    if (Object.getOwnPropertySymbols(value).length) throw new Error("Not JSON");
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key), ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

const eventHash = async (
  scope: string,
  index: number,
  previousHash: string | null,
  event: AuditEvent,
): Promise<string> => {
  const { hash: _hash, previousHash: _previousHash, ...content } = event;
  const bytes = new TextEncoder().encode(canonical({ scope, index, previousHash, event: content }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const verifyAuditChain = async (
  scope: string,
  events: AuditEvent[],
  anchor?: Anchor,
): Promise<Result<void, "AUDIT_INVALID">> => {
  try {
    if (
      !events.length ||
      (anchor &&
        (!Number.isSafeInteger(anchor.count) || anchor.count < 1 || anchor.count > events.length))
    )
      return err("AUDIT_INVALID");
    let previousHash: string | null = null;
    for (const [i, event] of events.entries()) {
      if (
        event.previousHash !== previousHash ||
        typeof event.hash !== "string" ||
        event.hash !== (await eventHash(scope, i, previousHash, event))
      )
        return err("AUDIT_INVALID");
      previousHash = event.hash;
      if (anchor && i + 1 === anchor.count && event.hash !== anchor.hash)
        return err("AUDIT_INVALID");
    }
    return ok(undefined);
  } catch {
    return err("AUDIT_INVALID");
  }
};

export const appendAudit = async (
  scope: string,
  previous: AuditEvent[],
  appended: AuditEvent[],
): Promise<Result<AuditEvent[], "AUDIT_INVALID">> => {
  try {
    if (previous.length && !(await verifyAuditChain(scope, previous)).ok)
      return err("AUDIT_INVALID");
    const result = [...previous];
    let previousHash = previous.at(-1)?.hash ?? null;
    for (const event of appended) {
      if (event.hash !== undefined || event.previousHash !== undefined) return err("AUDIT_INVALID");
      const hash = await eventHash(scope, result.length, previousHash, event);
      result.push({ ...event, previousHash, hash });
      previousHash = hash;
    }
    return ok(result);
  } catch {
    return err("AUDIT_INVALID");
  }
};

const projection = (order: Order, issuer: string, anchor: Anchor): OrderReceiptClaims | null => {
  const placed = order.audit.slice(0, anchor.count).findLast((event) => event.event === "placed");
  if (order.status !== "placed" || !placed) return null;
  const parsed = OrderReceiptClaimsSchema.safeParse({
    iss: issuer,
    orderId: order.orderId,
    customer: order.customer,
    agentId: order.agentId,
    accountId: order.accountId,
    offerIds: order.offerIds,
    lines: order.lines,
    mandateId: order.mandateId,
    mandateVersion: order.mandateVersion,
    paymentTerms: order.paymentTerms,
    total: order.total,
    decision: order.decision,
    createdAt: order.createdAt,
    placedAt: placed.at,
    auditAnchor: anchor,
    status: order.status,
  });
  return parsed.success ? parsed.data : null;
};

export const signOrderReceipt = async (
  order: Order,
  key: OfferSigningKey,
  issuer: string,
): Promise<Result<string, "UPSTREAM_FAILED">> => {
  try {
    if (
      !order.auditAnchor ||
      order.auditAnchor.count !== order.audit.length ||
      !(await verifyAuditChain(`order:${order.orderId}`, order.audit, order.auditAnchor)).ok
    )
      return err("UPSTREAM_FAILED");
    const claims = projection(order, issuer, order.auditAnchor);
    if (!claims) return err("UPSTREAM_FAILED");
    return ok(
      await new SignJWT({ ...claims })
        .setProtectedHeader({ alg: ALG, kid: key.kid, typ: "receipt+jwt" })
        .sign(key.privateKey),
    );
  } catch {
    return err("UPSTREAM_FAILED");
  }
};

export const verifyOrderReceipt = async (
  token: string,
  keys: OfferKeySet,
): Promise<Result<OrderReceiptClaims, "RECEIPT_INVALID">> => {
  try {
    const claims = await verifyTypedJws({
      token,
      typ: "receipt+jwt",
      keyFor: async (kid) => (kid === undefined ? null : keys(kid)),
      schema: OrderReceiptClaimsSchema,
    });
    return claims ? ok(claims) : err("RECEIPT_INVALID");
  } catch {
    return err("RECEIPT_INVALID");
  }
};

export const verifyOrderIntegrity = async (
  order: Order,
  keys: OfferKeySet,
): Promise<Result<void, "RECEIPT_INVALID" | "AUDIT_INVALID">> => {
  if (!order.receipt || !order.auditAnchor) return err("RECEIPT_INVALID");
  const receipt = await verifyOrderReceipt(order.receipt, keys);
  if (!receipt.ok) return err("RECEIPT_INVALID");
  try {
    const claims = receipt.value;
    if (canonical(order.auditAnchor) !== canonical(claims.auditAnchor))
      return err("RECEIPT_INVALID");
    const audit = await verifyAuditChain(`order:${order.orderId}`, order.audit, claims.auditAnchor);
    if (!audit.ok) return err("AUDIT_INVALID");
    const expected = projection(order, claims.iss, claims.auditAnchor);
    if (!expected || canonical(expected) !== canonical(claims)) return err("RECEIPT_INVALID");
    return ok(undefined);
  } catch {
    return err("RECEIPT_INVALID");
  }
};
