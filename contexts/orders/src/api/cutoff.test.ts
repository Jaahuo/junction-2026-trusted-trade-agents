import { expect, test } from "bun:test";
import { DEMO_ACCOUNT } from "@app/contract";
import { verifyAuditChain } from "@app/contract/server";
import { err } from "@app/kernel";
import { eq } from "drizzle-orm";
import { runCutoffJob } from "../application/cutoff.ts";
import { postgresOrderStore } from "../infra/order-store.ts";
import { orders } from "../infra/schema.ts";
import { withDatabase } from "./test-database.ts";
import { call, inMinutes, mount, orderOf, overLimit, place } from "./test-support.ts";

test("cutoff boundary expires only due pending orders once and pending reads recover after restart", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign } = await mount(db);
    const due = await orderOf(
      await place(app, [await sign({ ...overLimit, cutoffAt: inMinutes(5).toISOString() })]),
    );
    const future = await orderOf(
      await place(app, [await sign({ ...overLimit, cutoffAt: inMinutes(7).toISOString() })]),
    );
    const store = postgresOrderStore(db);
    const deps = { store, now: () => clock.now };
    clock.now = inMinutes(5);
    await runCutoffJob(deps);
    const expired = await store.find(DEMO_ACCOUNT.customer, due.orderId);
    expect(expired?.status).toBe("declined");
    expect(expired?.decision).toMatchObject({
      action: "reject",
      next: "alternatives",
      by: "server",
    });
    expect(expired?.audit.at(-1)).toMatchObject({
      actor: "server",
      event: "declined",
      reason: "CUTOFF_PASSED",
    });
    if (expired?.auditAnchor === undefined) throw new Error("Missing audit anchor");
    expect(
      (await verifyAuditChain(`order:${due.orderId}`, expired.audit, expired.auditAnchor)).ok,
    ).toBe(true);
    expect((await store.find(DEMO_ACCOUNT.customer, future.orderId))?.status).toBe(
      "pending_approval",
    );
    await runCutoffJob(deps);
    expect(await store.find(DEMO_ACCOUNT.customer, due.orderId)).toEqual(expired);
    clock.now = inMinutes(7);
    const response = await call(app, "GET", "/pending");
    expect(response.status).toBe(200);
    expect((await response.json()).orders).toEqual([]);
    expect((await store.find(DEMO_ACCOUNT.customer, future.orderId))?.status).toBe("declined");
  }));

test("cutoff rechecks a candidate after a concurrent decision", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign } = await mount(db);
    const pending = await orderOf(
      await place(app, [await sign({ ...overLimit, cutoffAt: inMinutes(5).toISOString() })]),
    );
    const base = postgresOrderStore(db);
    const store = {
      ...base,
      expiredPending: async (now: Date, customer?: string) => {
        const candidates = await base.expiredPending(now, customer);
        const response = await call(app, "POST", `/${pending.orderId}/decision`, {
          decision: "reject",
          next: "stop",
          proposalVersion: pending.proposalVersion,
        });
        expect(response.status).toBe(200);
        return candidates;
      },
    };
    clock.now = inMinutes(4);
    await runCutoffJob({ store, now: () => inMinutes(5) });
    const decided = await base.find(DEMO_ACCOUNT.customer, pending.orderId);
    expect(decided?.decision?.next).toBe("stop");
    expect(decided?.audit.filter((event) => event.event === "declined")).toHaveLength(1);
  }));

test("an invalid audit is not rewritten and one failed candidate does not block another", async () =>
  withDatabase(async (db) => {
    const { app, clock, sign } = await mount(db);
    const bad = await orderOf(
      await place(app, [await sign({ ...overLimit, cutoffAt: inMinutes(5).toISOString() })]),
    );
    const good = await orderOf(
      await place(app, [await sign({ ...overLimit, cutoffAt: inMinutes(5).toISOString() })]),
    );
    const future = await orderOf(
      await place(app, [await sign({ ...overLimit, cutoffAt: inMinutes(8).toISOString() })]),
    );
    const tampered = bad.audit.map((event, index) =>
      index === 0 ? { ...event, detail: "tampered" } : event,
    );
    await db.update(orders).set({ audit: tampered }).where(eq(orders.orderId, bad.orderId));
    const store = postgresOrderStore(db);
    clock.now = inMinutes(5);
    const failure = await runCutoffJob({ store, now: () => clock.now }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const unchanged = await store.find(DEMO_ACCOUNT.customer, bad.orderId);
    expect(unchanged?.status).toBe("pending_approval");
    expect(unchanged?.audit).toEqual(tampered);
    expect((await store.find(DEMO_ACCOUNT.customer, good.orderId))?.status).toBe("declined");
    const response = await call(app, "GET", "/pending");
    expect(response.status).toBe(200);
    const pending = await response.json();
    expect(pending.orders.map((order: { orderId: string }) => order.orderId)).toEqual([
      future.orderId,
    ]);
  }));

test("cutoff never signs a placement receipt and decision rechecks time under lock", async () =>
  withDatabase(async (db) => {
    const { app, appWith, clock, sign } = await mount(db);
    const pending = await orderOf(
      await place(app, [await sign({ ...overLimit, cutoffAt: inMinutes(5).toISOString() })]),
    );
    const base = postgresOrderStore(db);
    const guarded = appWith({
      store: {
        ...base,
        withCustomerLock: (customer, work) =>
          base.withCustomerLock(customer, async (tx) => {
            clock.now = inMinutes(5);
            return work(tx);
          }),
      },
      signReceipt: async () => err("UPSTREAM_FAILED"),
    });
    clock.now = inMinutes(4);
    const response = await call(guarded, "POST", `/${pending.orderId}/decision`, {
      decision: "approve",
      proposalVersion: pending.proposalVersion,
    });
    expect(response.status).toBe(409);
    const declined = await base.find(DEMO_ACCOUNT.customer, pending.orderId);
    expect(declined?.status).toBe("declined");
    expect(declined?.receipt).toBeUndefined();
    expect(declined?.audit.at(-1)).toMatchObject({ actor: "server", reason: "CUTOFF_PASSED" });
  }));
