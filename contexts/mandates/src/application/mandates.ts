import type { Mandate, Principal, RegisterMandateRequest, StoredMandate } from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { buildMandate, isCurrent } from "../domain/mandate.ts";

export interface MandateOwner {
  readonly customer: string;
  readonly agent: string;
}

/** Signs a mandate as the buyer: an ES256 compact JWS whose payload is exactly the mandate. */
export type MandateSigner = (mandate: Mandate) => Promise<string>;

interface SignedMandate {
  readonly mandate: Mandate;
  readonly jws: string;
}

export interface Registration {
  readonly stored: StoredMandate;
  /** True when the operationId was registered before and the stored mandate is returned unchanged. */
  readonly replayed: boolean;
}

export interface MandateStore {
  /**
   * In one transaction, serialised per owner: returns the mandate stored under `operationId` when
   * there is one; otherwise revokes the owner's active mandate and stores the signed mandate that
   * `next` builds from the highest stored version (0 when none).
   */
  replaceActive(
    owner: MandateOwner,
    operationId: string | undefined,
    next: (previousVersion: number) => Promise<SignedMandate>,
    registeredAt: Date,
  ): Promise<Registration>;
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
  ports: { store: MandateStore; sign: MandateSigner },
  principal: Principal,
  request: RegisterMandateRequest,
  now: Date,
  mandateId: string = newMandateId(),
): Promise<Registration> =>
  ports.store.replaceActive(
    ownerOf(principal),
    request.operationId,
    async (previousVersion) => {
      const mandate = buildMandate({ principal, request, mandateId, previousVersion, now });
      return { mandate, jws: await ports.sign(mandate) };
    },
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
