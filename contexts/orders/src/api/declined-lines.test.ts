import { expect, test } from "bun:test";
import { fixtures } from "@app/contract";
import { withDatabase } from "./test-database.ts";
import { call, mount, orderOf, place } from "./test-support.ts";

test("the order route returns the lines of a declined order", async () =>
  withDatabase(async (db) => {
    const { app, sign } = await mount(db);
    const originalRequest = "Order oat drink and coffee for the office next week.";
    const note = "Please find less expensive alternatives.";
    const claims = [
      {
        productId: "prod_test_office_oat",
        product: { ...fixtures.offerClaims.product, name: "Office oat drink" },
        quantity: { value: 20, unit: "CT" as const },
        unitPrice: { net: 30, vatRate: 14, currency: "EUR" as const },
        total: { net: 600, gross: 684 },
      },
      {
        productId: "prod_test_office_coffee",
        product: { ...fixtures.offerClaims.product, name: "Office coffee" },
        quantity: { value: 10, unit: "CT" as const },
        unitPrice: { net: 40, vatRate: 14, currency: "EUR" as const },
        total: { net: 400, gross: 456 },
      },
    ];

    for (const next of ["alternatives", "stop"] as const) {
      const tokens = await Promise.all(claims.map((line) => sign(line)));
      const placed = await place(app, tokens, { originalRequest });
      expect(placed.status).toBe(201);
      const pending = await orderOf(placed);
      expect(pending.status).toBe("pending_approval");
      expect(pending.lines).toHaveLength(2);
      for (const [index, line] of pending.lines.entries()) {
        const token = tokens[index];
        const expected = claims[index];
        if (token === undefined || expected === undefined) throw new Error("Missing expected line");
        expect(line.token).toBe(token);
        expect(line.claims).toMatchObject(expected);
      }

      const response = await call(app, "POST", `/${pending.orderId}/decision`, {
        proposalVersion: pending.proposalVersion,
        decision: "reject",
        next,
        note,
      });
      expect(response.status).toBe(200);
      const declined = await orderOf(response);
      expect(declined).toMatchObject({
        status: "declined",
        originalRequest,
        decision: { action: "reject", next, note },
      });

      const fetched = await call(app, "GET", `/${pending.orderId}`);
      expect(fetched.status).toBe(200);
      const order = await orderOf(fetched);
      expect(order.lines).toEqual(pending.lines);
      expect(order.originalRequest).toBe(originalRequest);
      expect(order.status).toBe("declined");
      expect(order.decision).toEqual(declined.decision);
    }
  }));
