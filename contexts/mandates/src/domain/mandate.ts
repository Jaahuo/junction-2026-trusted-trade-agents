import type {
  DraftMandateRequest,
  Mandate,
  Principal,
  RegisterMandateRequest,
  StoredMandate,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";

const defaultLifetimeSeconds = 365 * 24 * 60 * 60;

const epochSeconds = (now: Date): number => Math.floor(now.getTime() / 1000);

/** A requested `exp` must be after the server time in epoch seconds (SPEC-008). */
export const checkTerms = <T extends DraftMandateRequest>(
  request: T,
  now: Date,
): Result<T, "expired"> =>
  request.exp !== undefined && request.exp <= epochSeconds(now) ? err("expired") : ok(request);

/** Builds the next mandate of the principal; the server sets every identity field (SPEC-008). */
export const buildMandate = (input: {
  principal: Principal;
  request: RegisterMandateRequest;
  mandateId: string;
  previousVersion: number;
  now: Date;
}): Mandate => {
  const iat = epochSeconds(input.now);
  return {
    iss: input.principal.customer,
    mandateId: input.mandateId,
    version: input.previousVersion + 1,
    agent: input.principal.agentId,
    signedBy: input.principal.accountId,
    limits: input.request.limits,
    standingConstraints: input.request.standingConstraints,
    iat,
    exp: input.request.exp ?? iat + defaultLifetimeSeconds,
  };
};

/** An active mandate that has not expired is current. */
export const isCurrent = (stored: StoredMandate, now: Date): boolean =>
  stored.status === "active" && stored.mandate.exp > epochSeconds(now);
