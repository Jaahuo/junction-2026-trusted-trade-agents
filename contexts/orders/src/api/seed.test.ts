import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, type DemoProducts, OrderSchema, StoredMandateSchema } from "@app/contract";
import {
  localOfferKeys,
  offerSigningKeyFromEnv,
  signOrderReceipt,
  verifyAuditChain,
  verifyOfferToken,
  verifyOrderIntegrity,
} from "@app/contract/server";
import { type Db, mountContext } from "@app/server-kit";
import { context as mandatesContext, createApi as createMandatesApi } from "@ctx/mandates/api";
import { mandateClient } from "../infra/mandate-client.ts";
import { postgresOrderStore } from "../infra/order-store.ts";
import { history, refusalAnchors, refusals } from "../infra/schema.ts";
import { context, createApi } from "./index.ts";
import { seed, seedHistory } from "./seed.ts";
import { withDatabase } from "./test-database.ts";

const withSeedDatabase = (run: (db: Db) => Promise<void>) =>
  withDatabase(async (db) => {
    await mountContext(db, context);
    await run(db);
  });

// Invented products (team rules R-23).
const demo: DemoProducts = {
  observedAt: "2026-11-14T08:00:00Z",
  requestedDate: "2026-11-16",
  s1: { productId: "prod_test_small", quantity: { value: 20, unit: "LTR" } },
  s2: { productId: "prod_test_large", quantity: { value: 1001, unit: "LTR" } },
  s3: null,
  late: null,
  triedForS3: [],
};

test("the seed uses imported demo metadata for history", async () =>
  withSeedDatabase(async (db) => {
    await seedHistory(db, { demo, warn: () => undefined });
    const rows = await db
      .select({
        customer: history.customer,
        productId: history.productId,
        quantity: history.quantity,
      })
      .from(history);
    const small = {
      customer: DEMO_ACCOUNT.customer,
      productId: "prod_test_small",
      quantity: { value: 20, unit: "LTR" },
    };
    const large = {
      customer: DEMO_ACCOUNT.customer,
      productId: "prod_test_large",
      quantity: { value: 201, unit: "LTR" },
    };
    expect(rows).toEqual([small, small, small, large, large, large]);
  }));

test("without imported demo metadata the seed adds no history and warns once", async () =>
  withSeedDatabase(async (db) => {
    const warnings: string[] = [];
    await seedHistory(db, {
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(await db.select().from(history)).toEqual([]);
  }));

test("with a scenario 3 substitute the seed adds two approvals of the pair and its history", async () =>
  withSeedDatabase(async (db) => {
    await seedHistory(db, {
      demo: {
        ...demo,
        s3: { productId: "prod_test_partial", quantity: { value: 220, unit: "ST" } },
        s3Substitute: { productId: "prod_test_substitute" },
      },
      warn: () => undefined,
    });
    const pair = { replaces: "prod_test_partial", productId: "prod_test_substitute" };
    const approved = await postgresOrderStore(db).withCustomerLock(DEMO_ACCOUNT.customer, (tx) =>
      tx.approvedWithPair(DEMO_ACCOUNT.customer, pair),
    );
    expect(approved.map((order) => [order.status, order.decision?.action])).toEqual([
      ["placed", "approve"],
      ["placed", "approve"],
    ]);
    expect(approved.map((order) => order.lines[0]?.claims.product.name)).toEqual([
      "Demo earlier approved substitute",
      "Demo earlier approved substitute",
    ]);
    expect(approved.every((order) => order.auditAnchor?.count === order.audit.length)).toBe(true);
    const substituteRows = (await db.select().from(history)).filter(
      (row) => row.productId === pair.productId,
    );
    expect(substituteRows).toHaveLength(2);
  }));

test("the reset seed creates signed, current demo activity with intact audit chains", async () =>
  withDatabase(async (db) => {
    await mountContext(db, mandatesContext);
    await mandatesContext.seed?.(db);
    await mountContext(db, context);
    const mandates = createMandatesApi(db);
    const response = await mandates.handle(new Request("http://localhost/mandates/current"));
    const mandate = StoredMandateSchema.parse(await response.json()).mandate;
    const before = Date.now();
    const fetcher = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        url.pathname = url.pathname.replace(/^\/api/, "");
        return mandates.handle(new Request(url, request));
      },
      { preconnect: fetch.preconnect },
    );
    await seed(db, { fetcher });
    const after = Date.now();
    const store = postgresOrderStore(db);
    const placed = await store.findByKey(DEMO_ACCOUNT.customer, "demo-activity-placed");
    const pending = await store.findByKey(DEMO_ACCOUNT.customer, "demo-activity-pending");
    if (placed === null || pending === null) throw new Error("Missing seeded activity.");
    expect(placed.status).toBe("placed");
    expect(pending.status).toBe("pending_approval");
    expect(await store.expiredPending(new Date(), DEMO_ACCOUNT.customer)).toEqual([]);
    const key = await offerSigningKeyFromEnv();
    const keys = localOfferKeys({ keys: [key.publicJwk] });
    for (const order of [placed, pending]) {
      const { idempotencyKey: _key, requested: _request, ...publicOrder } = order;
      const parsed = OrderSchema.parse({ ...publicOrder, approvalUrl: null });
      expect(new Date(order.createdAt).getTime()).toBeGreaterThanOrEqual(before);
      expect(new Date(order.createdAt).getTime()).toBeLessThanOrEqual(after);
      expect(order.mandateId).toBe(mandate.mandateId);
      expect(order.mandateVersion).toBe(mandate.version);
      expect(order.auditAnchor).toBeDefined();
      const failures = order.audit.filter((event) => event.event === "check_failed");
      expect(failures.length).toBeGreaterThan(0);
      for (const failure of failures) {
        expect(failure.rule).toBeTruthy();
        expect(failure.detail).toContain(mandate.mandateId);
        expect(failure.detail).toContain(String(mandate.version));
      }
      if (order.auditAnchor === undefined) throw new Error("Missing audit anchor.");
      expect(
        (await verifyAuditChain(`order:${order.orderId}`, order.audit, order.auditAnchor)).ok,
      ).toBe(true);
      const line = order.lines[0];
      if (line === undefined) throw new Error("Missing demo line.");
      expect(line.claims.product.name).toStartWith("Demo ");
      expect(line.claims.productId).toStartWith("prod_demo_");
      expect(line.claims.mandateId).toBe(mandate.mandateId);
      expect(line.claims.mandateVersion).toBe(mandate.version);
      expect(line.claims.total).toEqual(order.total);
      expect(line.claims.exp * 1000).toBeGreaterThan(after);
      expect(new Date(line.claims.cutoffAt ?? "").getTime()).toBeGreaterThan(after);
      expect((await verifyOfferToken(line.token, keys, new Date())).ok).toBe(true);
      if (order.status === "placed")
        expect((await verifyOrderIntegrity(parsed, keys)).ok).toBe(true);
    }
    expect(placed.decision).toMatchObject({ action: "approve", by: DEMO_ACCOUNT.accountId });
    expect(placed.audit).toContainEqual(
      expect.objectContaining({ actor: "approver", event: "approved" }),
    );
    expect(placed.reasons).toContain("NEW_PRODUCT");
    expect(placed.audit).toContainEqual(
      expect.objectContaining({
        event: "check_failed",
        reason: "NEW_PRODUCT",
        rule: "New product policy",
        detail: expect.stringContaining("History count 0; policy ask"),
      }),
    );
    expect(pending.lines[0]?.claims.productId).not.toBe(placed.lines[0]?.claims.productId);
    expect(pending.total.gross).toBeGreaterThan(mandate.limits.maxOrderTotal.value);
    const failed = pending.audit.find(
      (event) => event.event === "check_failed" && event.reason === "SPEND_OVER_LIMIT",
    );
    expect(failed).toMatchObject({ reason: "SPEND_OVER_LIMIT", rule: "Maximum order total" });
    expect(failed?.detail).toContain(String(pending.total.gross));
    expect(failed?.detail).toContain(String(mandate.limits.maxOrderTotal.value));
    expect(failed?.detail).toContain(mandate.mandateId);
    const events = (await db.select().from(refusals)).map((row) => row.event);
    const [anchor] = await db.select().from(refusalAnchors);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "order_refused", detail: "OFFER_INVALID" });
    if (anchor === undefined) throw new Error("Missing refusal anchor.");
    expect((await verifyAuditChain(`refusals:${DEMO_ACCOUNT.customer}`, events, anchor)).ok).toBe(
      true,
    );

    const orders = createApi(db, {
      mandates: mandateClient(mandates),
      publicBaseUrl: () => "http://seed.local",
      signReceipt: ({ idempotencyKey: _key, requested: _requested, ...order }) =>
        signOrderReceipt({ ...order, approvalUrl: null }, key, "http://seed.local"),
    });
    const decision = await orders.handle(
      new Request(`http://localhost/orders/${pending.orderId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalVersion: pending.proposalVersion, decision: "approve" }),
      }),
    );
    expect(decision.status).toBe(200);
    expect(OrderSchema.parse(await decision.json()).status).toBe("placed");
  }));

test("the reset seed keeps imported scenario history and approvals alongside demo activity", async () =>
  withDatabase(async (db) => {
    await mountContext(db, mandatesContext);
    await mandatesContext.seed?.(db);
    await mountContext(db, context);
    const mandates = createMandatesApi(db);
    const fetcher = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        url.pathname = url.pathname.replace(/^\/api/, "");
        return mandates.handle(new Request(url, request));
      },
      { preconnect: fetch.preconnect },
    );
    await seed(db, {
      fetcher,
      demoProducts: {
        ...demo,
        s3: { productId: "prod_test_partial", quantity: { value: 220, unit: "ST" } },
        s3Substitute: { productId: "prod_test_substitute" },
      },
    });
    const rows = await db.select().from(history);
    expect(rows).toHaveLength(12);
    const store = postgresOrderStore(db);
    const approved = await store.withCustomerLock(DEMO_ACCOUNT.customer, (tx) =>
      tx.approvedWithPair(DEMO_ACCOUNT.customer, {
        replaces: "prod_test_partial",
        productId: "prod_test_substitute",
      }),
    );
    expect(approved).toHaveLength(2);
    const pending = await store.findByKey(DEMO_ACCOUNT.customer, "demo-activity-pending");
    expect(pending?.status).toBe("pending_approval");
    expect(await store.findByKey(DEMO_ACCOUNT.customer, "demo-activity-placed")).not.toBeNull();
    expect(await db.select().from(refusals)).toHaveLength(1);
  }));
