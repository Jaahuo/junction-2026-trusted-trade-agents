import { expect, test } from "bun:test";
import { err } from "@app/kernel";
import { SignJWT } from "jose";
import { fixtures, type AuditEvent, type Order } from "../index.ts";
import { localOfferKeys, type OfferSigningKey } from "./offer-token.ts";
import {
  appendAudit,
  signOrderReceipt,
  verifyAuditChain,
  verifyOrderIntegrity,
  verifyOrderReceipt,
} from "./order-integrity.ts";

const keyPair = async (kid: string): Promise<OfferSigningKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid,
    alg: "ES256",
  };
  return { kid, privateKey: pair.privateKey, publicJwk };
};

const events: AuditEvent[] = [
  {
    at: "2026-11-14T10:05:00+00:00",
    actor: "agent",
    event: "order_requested",
    rule: "R1",
    detail: "first",
  },
  { at: "2026-11-14T10:06:00+00:00", actor: "server", event: "placed", detail: "final" },
];

const chain = async (scope = "ord_test_1", input = events) => {
  const result = await appendAudit(scope, [], input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const placedOrder = async (): Promise<Order> => {
  const audit = await chain("order:ord_test_1");
  const last = audit.at(-1);
  if (!last?.hash) throw new Error("Missing audit hash");
  return {
    ...fixtures.order,
    status: "placed",
    audit,
    auditAnchor: { hash: last.hash, count: audit.length },
  };
};

test("audit chains protect all event content, ordering, scope and anchored tails", async () => {
  const audit = await chain();
  const [first, second] = audit;
  const last = audit.at(-1);
  const input = events[0];
  if (!first || !second || !last?.hash || !input) throw new Error("Missing audit events or hash");
  const anchor = { hash: last.hash, count: audit.length };
  expect((await verifyAuditChain("ord_test_1", audit, anchor)).ok).toBe(true);
  for (const altered of [
    [{ ...first, rule: "R2" }, second],
    [{ ...first, detail: "changed" }, second],
    [second, first],
    [second],
    audit.slice(0, 1),
    [],
  ])
    expect(await verifyAuditChain("ord_test_1", altered, anchor)).toEqual(err("AUDIT_INVALID"));
  expect(await verifyAuditChain("another", audit, anchor)).toEqual(err("AUDIT_INVALID"));
  expect(await appendAudit("ord_test_1", events, [input])).toEqual(err("AUDIT_INVALID"));
  const extended = await appendAudit("ord_test_1", audit, [{ ...input, event: "approved" }]);
  if (!extended.ok) throw new Error(extended.error);
  expect((await verifyAuditChain("ord_test_1", extended.value, anchor)).ok).toBe(true);
  expect(await verifyAuditChain("ord_test_1", extended.value.slice(0, 1), anchor)).toEqual(
    err("AUDIT_INVALID"),
  );
});

test("canonical hashing includes future extension fields and rejects non-JSON values", async () => {
  const input = events[0];
  if (!input) throw new Error("Missing audit event");
  const extension = { ...input, extra: { value: 2, nested: ["x", true] } } as AuditEvent;
  const first = await chain("scope", [extension]);
  const reordered = await chain("scope", [
    { ...input, extra: { nested: ["x", true], value: 2 } } as AuditEvent,
  ]);
  const firstEvent = first[0];
  const reorderedEvent = reordered[0];
  if (!firstEvent || !reorderedEvent) throw new Error("Missing audit events");
  expect(firstEvent.hash).toBe(reorderedEvent.hash);
  const changed = [{ ...firstEvent, extra: { value: 3, nested: ["x", true] } } as AuditEvent];
  expect(await verifyAuditChain("scope", changed)).toEqual(err("AUDIT_INVALID"));
  expect(await appendAudit("scope", [], [{ ...input, extra: Infinity } as AuditEvent])).toEqual(
    err("AUDIT_INVALID"),
  );
});

test("receipt uses published public keys and binds final terms and audit", async () => {
  const key = await keyPair("receipt-key");
  const keys = localOfferKeys({ keys: [key.publicJwk] });
  const order = await placedOrder();
  const signed = await signOrderReceipt(order, key, "https://issuer.example");
  if (!signed.ok) throw new Error(signed.error);
  const complete = { ...order, receipt: signed.value };
  const [first, second] = complete.audit;
  if (!first || !second) throw new Error("Missing audit events");
  const verified = await verifyOrderReceipt(signed.value, keys);
  expect(verified.ok).toBe(true);
  expect((await verifyOrderIntegrity(complete, keys)).ok).toBe(true);
  expect(
    await verifyOrderIntegrity(
      { ...complete, total: { ...complete.total, gross: complete.total.gross + 1 } },
      keys,
    ),
  ).toEqual(err("RECEIPT_INVALID"));
  expect(await verifyOrderIntegrity({ ...complete, lines: [] }, keys)).toEqual(
    err("RECEIPT_INVALID"),
  );
  expect(
    await verifyOrderIntegrity({ ...complete, audit: complete.audit.slice(0, 1) }, keys),
  ).toEqual(err("AUDIT_INVALID"));
  expect(
    await verifyOrderIntegrity(
      { ...complete, audit: [{ ...first, detail: "changed" }, second] },
      keys,
    ),
  ).toEqual(err("AUDIT_INVALID"));
  expect(await verifyOrderIntegrity(order, keys)).toEqual(err("RECEIPT_INVALID"));
  expect(await signOrderReceipt({ ...order, audit: [] }, key, "issuer")).toEqual(
    err("UPSTREAM_FAILED"),
  );
});

test("receipt rejects wrong typ, kid and signatures", async () => {
  const key = await keyPair("key");
  const other = await keyPair("other");
  const keys = localOfferKeys({ keys: [key.publicJwk] });
  const order = await placedOrder();
  const signed = await signOrderReceipt(order, key, "issuer");
  if (!signed.ok) throw new Error(signed.error);
  const parsed = await verifyOrderReceipt(signed.value, keys);
  if (!parsed.ok) throw new Error(parsed.error);
  const token = (typ: string, kid: string, signer: OfferSigningKey) =>
    new SignJWT({ ...parsed.value })
      .setProtectedHeader({ alg: "ES256", typ, kid })
      .sign(signer.privateKey);
  expect(await verifyOrderReceipt(await token("offer+jwt", "key", key), keys)).toEqual(
    err("RECEIPT_INVALID"),
  );
  expect(await verifyOrderReceipt(await token("receipt+jwt", "missing", key), keys)).toEqual(
    err("RECEIPT_INVALID"),
  );
  expect(await verifyOrderReceipt(await token("receipt+jwt", "key", other), keys)).toEqual(
    err("RECEIPT_INVALID"),
  );
});
