import type {
  DraftMandateRequest,
  Mandate,
  MandateDraft,
  Principal,
  RegisterMandateRequest,
  StoredMandate,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { buildMandate, checkTerms, isCurrent } from "../domain/mandate.ts";

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

export type RegistrationError = "expired";

export interface MandateStore {
  /**
   * In one transaction, serialised per owner: returns the mandate stored under `operationId` when
   * there is one; otherwise builds a signed mandate from the highest stored version (0 when none)
   * and, if valid, revokes the owner's active mandate and stores the new mandate.
   */
  replaceActive(
    owner: MandateOwner,
    operationId: string | undefined,
    next: (previousVersion: number) => Promise<Result<SignedMandate, RegistrationError>>,
    registeredAt: Date,
  ): Promise<Result<Registration, RegistrationError>>;
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
): Promise<Result<Registration, RegistrationError>> =>
  ports.store.replaceActive(
    ownerOf(principal),
    request.operationId,
    async (previousVersion) => {
      if (!checkTerms(request, now).ok) return err("expired");
      const mandate = buildMandate({ principal, request, mandateId, previousVersion, now });
      return ok({ mandate, jws: await ports.sign(mandate) });
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

/** Checks a proposed mandate with the register rules and pairs it with the current mandate; stores nothing. */
export const draftMandate = async (
  store: MandateStore,
  principal: Principal,
  request: DraftMandateRequest,
  now: Date,
): Promise<Result<MandateDraft, RegistrationError>> => {
  const draft = checkTerms(request, now);
  if (!draft.ok) return draft;
  const current = await currentMandate(store, principal, now);
  return ok({ draft: draft.value, current: current.ok ? current.value : null });
};
