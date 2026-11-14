import type { StoredMandate } from "@app/contract";
import { ok } from "@app/kernel";
import type { Db } from "@app/server-kit";
import { and, eq, max, sql } from "drizzle-orm";
import type { MandateOwner, MandateStore } from "../application/mandates.ts";
import { mandates } from "./schema.ts";

type Row = typeof mandates.$inferSelect;

const toStored = (row: Row): StoredMandate => ({
  mandate: row.mandate,
  jws: row.jws,
  status: row.status,
  registeredAt: row.registeredAt.toISOString(),
});

const ownedBy = (owner: MandateOwner) =>
  and(eq(mandates.customer, owner.customer), eq(mandates.agent, owner.agent));

export const postgresMandateStore = (db: Db): MandateStore => ({
  replaceActive: async (owner, operationId, next, registeredAt) =>
    db.transaction(async (tx) => {
      // Serialises registers of one owner, so parallel registers cannot both see the same version
      // or both miss the same operationId.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mandates:${owner.customer}:${owner.agent}`}, 0))`,
      );
      if (operationId !== undefined) {
        const [earlier] = await tx
          .select()
          .from(mandates)
          .where(and(ownedBy(owner), eq(mandates.operationId, operationId)));
        if (earlier !== undefined) return ok({ stored: toStored(earlier), replayed: true });
      }
      const [latest] = await tx
        .select({ version: max(mandates.version) })
        .from(mandates)
        .where(ownedBy(owner));
      const result = await next(latest?.version ?? 0);
      if (!result.ok) return result;
      const { mandate, jws } = result.value;
      await tx
        .update(mandates)
        .set({ status: "revoked" })
        .where(and(ownedBy(owner), eq(mandates.status, "active")));
      const [row] = await tx
        .insert(mandates)
        .values({
          mandateId: mandate.mandateId,
          customer: owner.customer,
          agent: owner.agent,
          version: mandate.version,
          operationId: operationId ?? null,
          status: "active",
          mandate,
          jws,
          registeredAt,
        })
        .returning();
      if (row === undefined) throw new Error("insert returned no row");
      return ok({ stored: toStored(row), replayed: false });
    }),
  findActive: async (owner) => {
    const [row] = await db
      .select()
      .from(mandates)
      .where(and(ownedBy(owner), eq(mandates.status, "active")));
    return row === undefined ? null : toStored(row);
  },
  revoke: async (owner, mandateId) => {
    const [row] = await db
      .update(mandates)
      .set({ status: "revoked" })
      .where(and(ownedBy(owner), eq(mandates.mandateId, mandateId)))
      .returning();
    return row === undefined ? null : toStored(row);
  },
});
