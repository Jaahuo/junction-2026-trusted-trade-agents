import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, fixtures, OfferClaimsSchema } from "@app/contract";
import { ok } from "@app/kernel";
import { evaluateWithEvidence } from "../domain/evaluate.ts";
import { history } from "../infra/schema.ts";
import { withDatabase } from "./test-database.ts";
import { call, limitsWith, mount, orderOf, overLimit, place } from "./test-support.ts";

test("audit exposes spend and each product's missing data without duplicating reasons", async () =>
  withDatabase(async (db) => {
    const { app, register, sign } = await mount(db);
    const mandate = await register(
      limitsWith({
        newProducts: "ask",
        minDeliveryReliability: { value: 0.9, ifNoData: "ask" },
        maxCo2PerKg: { value: 2, ifNoData: "ask" },
      }),
    );
    const under = { mandateId: mandate.mandateId, mandateVersion: mandate.version };
    const product = { ...fixtures.offerClaims.product, deliveryReliability: null, co2PerKg: null };
    const order = await orderOf(
      await place(app, [
        await sign({ ...under, ...overLimit, productId: "prod_audit_a", product }),
        await sign({ ...under, productId: "prod_audit_b", product }),
      ]),
    );
    const failed = order.audit.filter((event) => event.event === "check_failed");
    const spend = failed.find((event) => event.reason === "SPEND_OVER_LIMIT");
    expect(spend?.productId).toBeUndefined();
    expect(spend?.rule).toBe("Maximum order total");
    expect(spend?.detail).toContain(String(order.total.gross));
    expect(spend?.detail).toContain(String(mandate.limits.maxOrderTotal.value));
    expect(spend?.detail).toContain(mandate.mandateId);
    expect(order.reasons.filter((reason) => reason === "UNCONFIRMED_DATA")).toHaveLength(1);
    const missing = failed.filter((event) => event.reason === "UNCONFIRMED_DATA");
    expect(missing).toHaveLength(4);
    expect(new Set(missing.map((event) => event.productId))).toEqual(
      new Set(["prod_audit_a", "prod_audit_b"]),
    );
    expect(
      missing.every(
        (event) => event.detail?.includes("unknown") && event.detail.includes(mandate.mandateId),
      ),
    ).toBe(true);
    const stored = await orderOf(await call(app, "GET", `/${order.orderId}`));
    expect(stored.audit).toEqual(order.audit);
  }));

test("unknown conversion and every hard constraint retain separate evidence", () => {
  const claim = {
    ...fixtures.offerClaims,
    stock: "unconfirmed" as const,
    product: { ...fixtures.offerClaims.product, perSalesUnit: null, match: {} },
    constraints: {
      ...fixtures.offerClaims.constraints,
      hard: [
        { attribute: "lactose" as const, is: "free_from" as const },
        { attribute: "egg" as const, is: "free_from" as const },
      ],
    },
  };
  const mandate = {
    ...fixtures.storedMandate.mandate,
    limits: {
      ...fixtures.storedMandate.mandate.limits,
      allergenData: { ifNoData: "ask" as const },
    },
  };
  const { evaluation, evidence } = evaluateWithEvidence({
    claims: [claim],
    mandate,
    history: [],
    live: null,
    now: new Date("2026-11-16T08:00:00Z"),
  });
  expect(evaluation.reasons).toContain("QUANTITY_UNUSUAL");
  expect(evidence.find((entry) => entry.reason === "QUANTITY_UNUSUAL")?.detail).toContain(
    "unknown (conversion unavailable)",
  );
  expect(evidence.find((entry) => entry.reason === "UNCONFIRMED_STOCK")?.detail).toContain("500");
  expect(
    evidence
      .filter((entry) => entry.reason === "UNCONFIRMED_ALLERGEN")
      .map((entry) => entry.detail),
  ).toEqual(
    expect.arrayContaining([expect.stringContaining("lactose"), expect.stringContaining("egg")]),
  );
});

test("credit failure includes the limit and mandate", async () =>
  withDatabase(async (db) => {
    const { app, register, sign } = await mount(db);
    const mandate = await register(
      limitsWith({ maxOrderTotal: { value: 10000, currency: "EUR", basis: "gross" } }),
    );
    const order = await orderOf(
      await place(app, [
        await sign({
          mandateId: mandate.mandateId,
          mandateVersion: mandate.version,
          total: { net: 5000, gross: 6000 },
        }),
      ]),
    );
    const event = order.audit.find(
      (entry) => entry.reason === "CREDIT_LIMIT" && entry.event === "check_failed",
    );
    expect(event?.rule).toBe("Invoice credit limit");
    expect(event?.detail).toContain("5000.00");
    expect(event?.detail).toContain("6000.00");
    expect(event?.detail).toContain(mandate.mandateId);
  }));

test("a missing current mandate is explicit in the audit", async () =>
  withDatabase(async (db) => {
    const { appWith, sign } = await mount(db);
    const app = appWith({ mandates: { current: async () => ok(null) } });
    const order = await orderOf(await place(app, [await sign()]));
    const event = order.audit.find((entry) => entry.reason === "MANDATE_INVALID");
    expect(event?.rule).toBe("Current mandate");
    expect(event?.detail).toContain("no current mandate");
  }));

test("approval without a current mandate records the missing mandate", async () =>
  withDatabase(async (db) => {
    const mounted = await mount(db);
    const pending = await orderOf(await place(mounted.app, [await mounted.sign(overLimit)]));
    const app = mounted.appWith({ mandates: { current: async () => ok(null) } });
    const rejected = await orderOf(
      await call(app, "POST", `/${pending.orderId}/decision`, {
        proposalVersion: pending.proposalVersion,
        decision: "approve",
      }),
    );
    const event = rejected.audit.find(
      (entry) => entry.reason === "MANDATE_INVALID" && entry.event === "check_failed",
    );
    expect(event?.rule).toBe("Current mandate");
    expect(event?.detail).toContain("No current mandate");
    expect(event?.detail).toContain(mounted.mandate.mandateId);
  }));

for (const kind of ["price", "deposit", "pack"] as const) {
  test(`revision preserves ${kind} change evidence`, async () =>
    withDatabase(async (db) => {
      const mounted = await mount(db);
      const app = mounted.appWith({
        offers: {
          requote: async (request) => {
            const token = request.tokens[0] ?? "";
            const previous = OfferClaimsSchema.parse(
              JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")),
            );
            const changed = {
              ...previous,
              offerId: `off_${crypto.randomUUID()}`,
              ...(kind === "price"
                ? { unitPrice: { ...previous.unitPrice, net: previous.unitPrice.net + 1 } }
                : {}),
              ...(kind === "deposit" ? { deposits: previous.deposits + 4 } : {}),
              ...(kind === "pack"
                ? { product: { ...previous.product, perSalesUnit: { value: 2, unit: "L" } } }
                : {}),
            };
            const fresh = await mounted.sign(changed);
            const claims = OfferClaimsSchema.parse(
              JSON.parse(Buffer.from(fresh.split(".")[1] ?? "", "base64url").toString("utf8")),
            );
            return ok({
              offers: [
                {
                  offerId: claims.offerId,
                  token: fresh,
                  claims,
                  precheck: null,
                  rank: null,
                  comparison: null,
                },
              ],
              omitted: [],
            });
          },
        },
      });
      const pending = await orderOf(await place(app, [await mounted.sign(overLimit)]));
      const revised = await orderOf(
        await call(app, "POST", `/${pending.orderId}/decision`, {
          proposalVersion: pending.proposalVersion,
          decision: "edit",
          changes: [
            { productId: fixtures.offerClaims.productId, quantity: fixtures.offerClaims.quantity },
          ],
        }),
      );
      const event = revised.audit.find((entry) => entry.reason === "PRICE_CHANGED");
      expect(event?.productId).toBe(fixtures.offerClaims.productId);
      expect(event?.rule).toBe("Requoted unit cost and pack");
      expect(event?.detail).toContain("Previous net");
      expect(event?.detail).toContain("current net");
      expect(event?.detail).toContain("deposit per sales unit");
      expect(event?.detail).toContain("pack");
      expect(event?.detail).toContain(mounted.mandate.mandateId);
    }));
}

test("revision retains quantity evidence without attributing historical failures to current products", async () =>
  withDatabase(async (db) => {
    const mounted = await mount(db);
    const productIds = ["prod_quantity_a", "prod_quantity_b"] as const;
    await db.insert(history).values(
      productIds.map((productId) => ({
        customer: DEMO_ACCOUNT.customer,
        productId,
        quantity: { value: 4, unit: "CT" },
        placedAt: mounted.clock.now,
      })),
    );
    const app = mounted.appWith({
      offers: {
        requote: async (request) => {
          const offers = await Promise.all(
            request.tokens.map(async (token) => {
              const previous = OfferClaimsSchema.parse(
                JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")),
              );
              const change = request.changes?.find(
                (entry) => entry.productId === previous.productId,
              );
              const fresh = await mounted.sign({
                ...previous,
                offerId: `off_${crypto.randomUUID()}`,
                quantity: change?.quantity ?? previous.quantity,
              });
              const claims = OfferClaimsSchema.parse(
                JSON.parse(Buffer.from(fresh.split(".")[1] ?? "", "base64url").toString("utf8")),
              );
              return {
                offerId: claims.offerId,
                token: fresh,
                claims,
                precheck: null,
                rank: null,
                comparison: null,
              };
            }),
          );
          return ok({ offers, omitted: [] });
        },
      },
    });
    const [a, b] = productIds;
    const pending = await orderOf(
      await place(app, [
        await mounted.sign({
          productId: a,
          product: { ...fixtures.offerClaims.product, name: "Product A" },
          quantity: { value: 41, unit: "CT" },
        }),
        await mounted.sign({
          productId: b,
          product: { ...fixtures.offerClaims.product, name: "Product B" },
          quantity: { value: 4, unit: "CT" },
        }),
      ]),
    );
    const old = pending.audit.filter((event) => event.reason === "QUANTITY_UNUSUAL");
    expect(old).toHaveLength(1);
    expect(old[0]?.detail).toContain("Product A (prod_quantity_a)");
    const revised = await orderOf(
      await call(app, "POST", `/${pending.orderId}/decision`, {
        proposalVersion: pending.proposalVersion,
        decision: "edit",
        changes: [
          { productId: a, quantity: { value: 4, unit: "CT" } },
          { productId: b, quantity: { value: 41, unit: "CT" } },
        ],
      }),
    );
    expect(revised.reasons).toContain("QUANTITY_UNUSUAL");
    const quantityEvents = revised.audit.filter((event) => event.reason === "QUANTITY_UNUSUAL");
    expect(quantityEvents).toHaveLength(2);
    expect(quantityEvents[0]).toEqual(old[0]);
    expect(quantityEvents.every((event) => event.productId === undefined)).toBe(true);
    expect(quantityEvents[1]?.detail).toContain("Product B (prod_quantity_b)");
    expect(quantityEvents[1]?.detail).toContain("41 CT");
    expect(quantityEvents[1]?.detail).toContain("median of 1 convertible history rows 4 CT");
    expect(quantityEvents[1]?.detail).toContain("limit 40 CT");
    const stored = await orderOf(await call(app, "GET", `/${pending.orderId}`));
    expect(stored.audit).toEqual(revised.audit);
  }));
