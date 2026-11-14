import { expect, test } from "bun:test";
import { PendingListSchema } from "@app/contract";
import { verifyAuditChain } from "@app/contract/server";
import { err } from "@app/kernel";
import { eq } from "drizzle-orm";
import { orders } from "../infra/schema.ts";
import { withDatabase } from "./test-database.ts";
import {
  call,
  counts,
  errorOf,
  inMinutes,
  limitsWith,
  mount,
  orderOf,
  overLimit,
  place,
} from "./test-support.ts";

for (const pending of [true, false]) {
  test(`an explicit ${pending ? "pending" : "placed"} replacement closes only its predecessor`, async () =>
    withDatabase(async (db) => {
      const { app, sign } = await mount(db);
      const previous = await orderOf(await place(app, [await sign(overLimit)]));
      const unrelated = await orderOf(await place(app, [await sign(overLimit)]));
      const response = await place(app, [await sign(pending ? overLimit : {})], {
        supersedes: { orderId: previous.orderId, proposalVersion: previous.proposalVersion },
      });
      expect(response.status).toBe(201);
      const replacement = await orderOf(response);
      expect(replacement.status).toBe(pending ? "pending_approval" : "placed");
      const closed = await orderOf(await call(app, "GET", `/${previous.orderId}`));
      expect(closed).toMatchObject({
        status: "declined",
        approvalUrl: null,
        decision: { action: "reject", next: "stop", by: "server" },
      });
      expect(closed.audit.at(-1)).toMatchObject({
        actor: "server",
        event: "declined",
        detail: `Replaced by ${replacement.orderId}`,
      });
      expect(replacement.audit[0]?.detail).toContain(previous.orderId);
      for (const order of [closed, replacement]) {
        expect(
          (await verifyAuditChain(`order:${order.orderId}`, order.audit, order.auditAnchor)).ok,
        ).toBe(true);
      }
      const list = PendingListSchema.parse(await (await call(app, "GET", "/pending")).json());
      expect(list.orders.map((order) => order.orderId).toSorted()).toEqual(
        (pending ? [unrelated.orderId, replacement.orderId] : [unrelated.orderId]).toSorted(),
      );
      expect((await counts(db)).history).toBe(pending ? 0 : 1);
    }));
}

test("replacement retry is idempotent and a changed replacement reference conflicts", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const previous = await orderOf(await place(app, [await sign(overLimit)]));
    const unrelated = await orderOf(await place(app, [await sign(overLimit)]));
    const request = {
      offers: [await sign(overLimit)],
      idempotencyKey: crypto.randomUUID(),
      supersedes: { orderId: previous.orderId, proposalVersion: previous.proposalVersion },
    };
    const created = await orderOf(await call(app, "POST", "", request));
    const replay = await call(app, "POST", "", request);
    expect(replay.status).toBe(200);
    expect((await orderOf(replay)).orderId).toBe(created.orderId);
    const changed = await call(app, "POST", "", {
      ...request,
      supersedes: { orderId: unrelated.orderId, proposalVersion: unrelated.proposalVersion },
    });
    expect(changed.status).toBe(409);
    const omitted = await call(app, "POST", "", {
      offers: request.offers,
      idempotencyKey: request.idempotencyKey,
    });
    expect(omitted.status).toBe(409);
    expect((await counts(db)).orders).toBe(3);
    expect((await orderOf(await call(app, "GET", `/${unrelated.orderId}`))).status).toBe(
      "pending_approval",
    );
  }));

for (const scenario of ["missing", "customer", "agent", "account", "version", "decided"] as const) {
  test(`a ${scenario} replacement reference cannot close a proposal or create an order`, async () =>
    withDatabase(async (db) => {
      const { app, sign } = await mount(db);
      const previous = await orderOf(await place(app, [await sign(overLimit)]));
      if (scenario === "customer" || scenario === "agent" || scenario === "account") {
        const change =
          scenario === "customer"
            ? { customer: "other-customer" }
            : scenario === "agent"
              ? { agentId: "other-agent" }
              : { accountId: "other-account" };
        await db.update(orders).set(change).where(eq(orders.orderId, previous.orderId));
      }
      if (scenario === "decided") {
        const declined = await call(app, "POST", `/${previous.orderId}/decision`, {
          proposalVersion: previous.proposalVersion,
          decision: "reject",
          next: "stop",
        });
        expect(declined.status).toBe(200);
      }
      const response = await place(app, [await sign()], {
        supersedes: {
          orderId: scenario === "missing" ? "ord_missing" : previous.orderId,
          proposalVersion: previous.proposalVersion + (scenario === "version" ? 1 : 0),
        },
      });
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe("CONFLICT");
      expect(await counts(db)).toMatchObject({ orders: 1, history: 0 });
      const [stored] = await db.select().from(orders).where(eq(orders.orderId, previous.orderId));
      expect(stored?.status).toBe(scenario === "decided" ? "declined" : "pending_approval");
    }));
}

for (const rejectedBy of ["expiry", "credit"] as const) {
  test(`a replacement rejected by ${rejectedBy} leaves its predecessor open`, async () =>
    withDatabase(async (db) => {
      const { app, sign, register } = await mount(db);
      const previous = await orderOf(await place(app, [await sign(overLimit)]));
      const mandate = await register(
        limitsWith({ maxOrderTotal: { value: 10_000, currency: "EUR", basis: "gross" } }),
      );
      const token = await sign(
        {
          ...(rejectedBy === "credit" ? { total: { net: 5400, gross: 6000 } } : {}),
          mandateId: mandate.mandateId,
          mandateVersion: mandate.version,
        },
        rejectedBy === "expiry" ? inMinutes(-1) : inMinutes(10),
      );
      const response = await place(app, [token], {
        supersedes: { orderId: previous.orderId, proposalVersion: previous.proposalVersion },
      });
      const result = await orderOf(response);
      expect(result.status).toBe("rejected");
      expect(result.reasons).toContain(rejectedBy === "credit" ? "CREDIT_LIMIT" : "OFFER_EXPIRED");
      expect((await orderOf(await call(app, "GET", `/${previous.orderId}`))).status).toBe(
        "pending_approval",
      );
      expect(await counts(db)).toMatchObject({ orders: 2, history: 0 });
    }));
}

test("receipt failure leaves the predecessor open and writes no replacement or history", async () =>
  withDatabase(async (db) => {
    const { app, appWith, sign } = await mount(db);
    const previous = await orderOf(await place(app, [await sign(overLimit)]));
    const broken = appWith({ signReceipt: async () => err("UPSTREAM_FAILED") });
    const response = await place(broken, [await sign()], {
      supersedes: { orderId: previous.orderId, proposalVersion: previous.proposalVersion },
    });
    expect(response.status).toBe(502);
    expect((await orderOf(await call(app, "GET", `/${previous.orderId}`))).status).toBe(
      "pending_approval",
    );
    expect(await counts(db)).toMatchObject({ orders: 1, history: 0 });
  }));

test("two concurrent replacements cannot both replace the same proposal", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const previous = await orderOf(await place(app, [await sign(overLimit)]));
    const tokens = await Promise.all([sign(overLimit), sign(overLimit)]);
    const responses = await Promise.all(
      tokens.map((token) =>
        place(app, [token], {
          supersedes: { orderId: previous.orderId, proposalVersion: previous.proposalVersion },
        }),
      ),
    );
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(await counts(db)).toMatchObject({ orders: 2, history: 0 });
    expect((await orderOf(await call(app, "GET", `/${previous.orderId}`))).status).toBe("declined");
  }));

test("a broken predecessor audit prevents an automatic replacement and its history", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const previous = await orderOf(await place(app, [await sign(overLimit)]));
    await db.update(orders).set({ audit: [] }).where(eq(orders.orderId, previous.orderId));
    const response = await place(app, [await sign()], {
      supersedes: { orderId: previous.orderId, proposalVersion: previous.proposalVersion },
    });
    expect(response.status).toBe(502);
    expect(await counts(db)).toMatchObject({ orders: 1, history: 0 });
  }));
