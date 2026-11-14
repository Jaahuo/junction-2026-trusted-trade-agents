import { expect, test } from "bun:test";
import type { AuditEvent } from "@app/contract";
import { verifyAuditChain } from "@app/contract/server";
import { type Db, mountContext } from "@app/server-kit";
import { asc, eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import type { OrderStore } from "../application/ports.ts";
import { postgresOrderStore } from "../infra/order-store.ts";
import { refusals } from "../infra/schema.ts";
import { context } from "./index.ts";
import { withDatabase } from "./test-database.ts";

const anchors = pgTable("orders_refusal_anchors", {
  customer: text().primaryKey(),
  hash: text().notNull(),
  count: integer().notNull(),
});

const customer = "refusal-chain-test-customer";
const event = (detail: string): AuditEvent => ({
  at: "2026-11-16T08:00:00.000Z",
  actor: "agent",
  event: "order_refused",
  detail,
});

const state = async (db: Db) => ({
  rows: await db
    .select()
    .from(refusals)
    .where(eq(refusals.customer, customer))
    .orderBy(asc(refusals.id)),
  anchors: await db.select().from(anchors).where(eq(anchors.customer, customer)),
});

const expectChain = async (db: Db, count: number) => {
  const { rows, anchors: found } = await state(db);
  expect(rows).toHaveLength(count);
  expect(found).toHaveLength(1);
  const anchor = found[0];
  const tail = rows[count - 1];
  if (anchor === undefined || tail === undefined) throw new Error("Missing refusal chain fixture.");
  if (tail.event.hash === undefined) throw new Error("Missing refusal tail hash.");
  expect(anchor.count).toBe(count);
  expect(anchor.hash).toBe(tail.event.hash);
  expect(
    (
      await verifyAuditChain(
        `refusals:${customer}`,
        rows.map((row) => row.event),
        anchor,
      )
    ).ok,
  ).toBe(true);
};

const setup = async (db: Db) => {
  await mountContext(db, context);
  return postgresOrderStore(db);
};

const populate = async (store: OrderStore) => {
  for (const detail of ["first", "second", "third"]) {
    expect((await store.refuse(customer, event(detail))).ok).toBe(true);
  }
};

const expectRejectedWithoutChange = async (db: Db, store: OrderStore) => {
  const before = await state(db);
  expect(await store.refuse(customer, event("next"))).toEqual({
    ok: false,
    error: "AUDIT_INVALID",
  });
  expect(await state(db)).toEqual(before);
};

test("repeated refusals have a verified chain and matching anchor", async () =>
  withDatabase(async (db) => {
    const store = await setup(db);
    await populate(store);
    await expectChain(db, 3);
  }));

test("deleting the last refusal is detected without changing rows or anchor", async () =>
  withDatabase(async (db) => {
    const store = await setup(db);
    await populate(store);
    const before = await state(db);
    const tail = before.rows[2];
    if (tail === undefined) throw new Error("Missing last refusal fixture.");
    await db.delete(refusals).where(eq(refusals.id, tail.id));
    await expectRejectedWithoutChange(db, store);
  }));

test("deleting every refusal is detected without creating a new genesis", async () =>
  withDatabase(async (db) => {
    const store = await setup(db);
    await populate(store);
    await db.delete(refusals).where(eq(refusals.customer, customer));
    await expectRejectedWithoutChange(db, store);
  }));

test("altering a middle refusal is detected without changing rows or anchor", async () =>
  withDatabase(async (db) => {
    const store = await setup(db);
    await populate(store);
    const before = await state(db);
    const middle = before.rows[1];
    if (middle === undefined) throw new Error("Missing middle refusal fixture.");
    await db
      .update(refusals)
      .set({ event: { ...middle.event, detail: "tampered" } })
      .where(eq(refusals.id, middle.id));
    await expectRejectedWithoutChange(db, store);
  }));

test("parallel refusals produce one continuous chain and anchor count", async () =>
  withDatabase(async (db) => {
    const store = await setup(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => store.refuse(customer, event(`parallel-${index}`))),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    await expectChain(db, results.length);
  }));
