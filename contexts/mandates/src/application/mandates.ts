import type { Mandate, Principal, RegisterMandateRequest, StoredMandate } from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { buildMandate, isCurrent } from "../domain/mandate.ts";

export interface MandateOwner {
  readonly customer: string;
  readonly agent: string;
}

export interface MandateStore {
  /**
   * In one transaction, serialised per owner: revokes the owner's active mandate and stores
   * the mandate that `next` builds from the highest stored version (0 when none).
   */
  replaceActive(
    owner: MandateOwner,
    next: (previousVersion: number) => Mandate,
    registeredAt: Date,
  ): Promise<StoredMandate>;
  findActive(owner: MandateOwner): Promise<StoredMandate | null>;
  /** Marks the owner's mandate revoked and returns it; null when the owner has no such mandate. */
  revoke(owner: MandateOwner, mandateId: string): Promise<StoredMandate | null>;
}

export type MandateLookupError = "not-found";

const ownerOf = (principal: Principal): MandateOwner => ({
  customer: principal.customer,
  agent: principal.agentId,
});

const newMandateId = (): string => `mnd_${crypto.randomUUID()}`;

export const registerMandate = (
  store: MandateStore,
  principal: Principal,
  request: RegisterMandateRequest,
  now: Date,
  mandateId: string = newMandateId(),
): Promise<StoredMandate> =>
  store.replaceActive(
    ownerOf(principal),
    (previousVersion) => buildMandate({ principal, request, mandateId, previousVersion, now }),
    now,
  );

export const currentMandate = async (
  store: MandateStore,
  principal: Principal,
  now: Date,
): Promise<Result<StoredMandate, MandateLookupError>> => {
  const stored = await store.findActive(ownerOf(principal));
  return stored !== null && isCurrent(stored, now) ? ok(stored) : err("not-found");
};

export const revokeMandate = async (
  store: MandateStore,
  principal: Principal,
  mandateId: string,
): Promise<Result<StoredMandate, MandateLookupError>> => {
  const stored = await store.revoke(ownerOf(principal), mandateId);
  return stored === null ? err("not-found") : ok(stored);
};
