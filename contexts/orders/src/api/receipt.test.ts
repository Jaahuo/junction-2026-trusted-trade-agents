import { expect, test } from "bun:test";
import { type DemoProducts, OrderSchema } from "@app/contract";
import {
  localOfferKeys,
  verifyAuditChain,
  verifyOrderIntegrity,
  verifyOrderReceipt,
} from "@app/contract/server";
import { eq } from "drizzle-orm";
import { history, orders } from "../infra/schema.ts";
import { seedHistory } from "./seed.ts";
import { withDatabase } from "./test-database.ts";
import { call, inMinutes, mount, orderOf, overLimit, place } from "./test-support.ts";

test("automatic placement signs final claims and GET and idempotent replay preserve receipt and audit", async () =>
  withDatabase(async (db) => {
    const { app, sign, mandate, jwks } = await mount(db);
    const keys = localOfferKeys(jwks);
    const body = { offers: [await sign()], idempotencyKey: crypto.randomUUID() };
    const response = await call(app, "POST", "", body);
    expect(response.status).toBe(201);
    const order = await orderOf(response);
    expect(order.status).toBe("placed");
    expect(order.receipt).toEqual(expect.any(String));
    if (order.receipt === undefined) throw new Error("Placed order has no receipt");
    const receipt = await verifyOrderReceipt(order.receipt, keys);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) throw new Error("Receipt did not verify");
    expect(receipt.value).toMatchObject({
      orderId: order.orderId,
      status: "placed",
      lines: order.lines,
      offerIds: order.offerIds,
      mandateId: mandate.mandateId,
      auditAnchor: order.auditAnchor,
    });
    expect(
      (await verifyAuditChain(`order:${order.orderId}`, order.audit, order.auditAnchor)).ok,
    ).toBe(true);
    expect((await verifyOrderIntegrity(order, keys)).ok).toBe(true);

    const readResponse = await call(app, "GET", `/${order.orderId}`);
    expect(readResponse.status).toBe(200);
    const read = await orderOf(readResponse);
    const replayResponse = await call(app, "POST", "", body);
    expect(replayResponse.status).toBe(200);
    const replay = await orderOf(replayResponse);
    for (const returned of [read, replay]) {
      expect(returned.receipt).toBe(order.receipt);
      expect(returned.audit).toEqual(order.audit);
      expect(returned.auditAnchor).toEqual(order.auditAnchor);
      expect((await verifyOrderIntegrity(returned, keys)).ok).toBe(true);
    }
  }));

test("only placement issues a receipt, including after approval", async () =>
  withDatabase(async (db) => {
    const { app, sign, jwks } = await mount(db);
    const keys = localOfferKeys(jwks);
    const pending = await orderOf(await place(app, [await sign(overLimit)]));
    expect(pending.status).toBe("pending_approval");
    expect(pending.receipt).toBeUndefined();
    const response = await call(app, "POST", `/${pending.orderId}/decision`, {
      proposalVersion: pending.proposalVersion,
      decision: "approve",
    });
    expect(response.status).toBe(200);
    const approved = await orderOf(response);
    expect(approved.status).toBe("placed");
    expect(approved.receipt).toEqual(expect.any(String));
    if (approved.receipt === undefined) throw new Error("Approved order has no receipt");
    expect((await verifyOrderReceipt(approved.receipt, keys)).ok).toBe(true);
    expect(
      (await verifyAuditChain(`order:${approved.orderId}`, approved.audit, approved.auditAnchor))
        .ok,
    ).toBe(true);
    expect((await verifyOrderIntegrity(approved, keys)).ok).toBe(true);
    expect(await orderOf(await call(app, "GET", `/${approved.orderId}`))).toEqual(approved);

    const rejected = await orderOf(await place(app, [await sign({}, inMinutes(-1))]));
    expect(rejected.status).toBe("rejected");
    expect(rejected.receipt).toBeUndefined();
    const pendingDecline = await orderOf(await place(app, [await sign(overLimit)]));
    expect(pendingDecline.status).toBe("pending_approval");
    const declined = await orderOf(
      await call(app, "POST", `/${pendingDecline.orderId}/decision`, {
        proposalVersion: pendingDecline.proposalVersion,
        decision: "reject",
        next: "stop",
      }),
    );
    expect(declined.status).toBe("declined");
    expect(declined.receipt).toBeUndefined();
  }));

test("persisted audit edits, removal, reordering and final-event truncation fail verification", async () =>
  withDatabase(async (db) => {
    const { app, sign, jwks } = await mount(db);
    const keys = localOfferKeys(jwks);
    const order = await orderOf(await place(app, [await sign()]));
    expect((await verifyOrderIntegrity(order, keys)).ok).toBe(true);
    const audit = order.audit;
    const [first, second] = audit;
    if (first === undefined || second === undefined) throw new Error("Expected two audit events");
    const variants = [
      audit.map((event, index) => (index === 0 ? { ...event, detail: "changed" } : event)),
      audit.filter((_, index) => index !== 1),
      [second, first, ...audit.slice(2)],
      audit.slice(0, -1),
    ];
    for (const changed of variants) {
      await db.update(orders).set({ audit: changed }).where(eq(orders.orderId, order.orderId));
      const response = await call(app, "GET", `/${order.orderId}`);
      expect(response.status).toBe(200);
      const returned = await orderOf(response);
      expect(returned.audit).toEqual(changed);
      expect(returned.receipt).toBe(order.receipt);
      expect(
        (await verifyAuditChain(`order:${order.orderId}`, returned.audit, order.auditAnchor)).ok,
      ).toBe(false);
      expect((await verifyOrderIntegrity(returned, keys)).ok).toBe(false);
    }
  }));

test("legacy unhashed audit remains parseable but cannot be verified", async () =>
  withDatabase(async (db) => {
    const { app, sign, jwks } = await mount(db);
    const order = await orderOf(await place(app, [await sign()]));
    const legacy = OrderSchema.parse({
      ...order,
      audit: order.audit.map(({ hash: _hash, previousHash: _previousHash, ...event }) => event),
    });
    expect(
      (await verifyAuditChain(`order:${legacy.orderId}`, legacy.audit, legacy.auditAnchor)).ok,
    ).toBe(false);
    expect((await verifyOrderIntegrity(legacy, localOfferKeys(jwks))).ok).toBe(false);
  }));

test("seeded history does not interfere with the first placed order's audit chain", async () =>
  withDatabase(async (db) => {
    const { app, sign, jwks } = await mount(db);
    const demo: DemoProducts = {
      observedAt: "2026-11-14T08:00:00Z",
      requestedDate: "2026-11-16",
      s1: { productId: "prod_test_small", quantity: { value: 20, unit: "LTR" } },
      s2: { productId: "prod_test_large", quantity: { value: 1001, unit: "LTR" } },
      s3: null,
      late: null,
      triedForS3: [],
    };
    await seedHistory(db, { demo, warn: () => undefined });
    expect(await db.select().from(history)).toHaveLength(6);
    expect(await db.select().from(orders)).toHaveLength(0);
    const order = await orderOf(await place(app, [await sign()]));
    expect(order.status).toBe("placed");
    expect(
      (await verifyAuditChain(`order:${order.orderId}`, order.audit, order.auditAnchor)).ok,
    ).toBe(true);
    expect((await verifyOrderIntegrity(order, localOfferKeys(jwks))).ok).toBe(true);
  }));
