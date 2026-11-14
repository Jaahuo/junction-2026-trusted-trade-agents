import { z } from "zod";
import { DateSchema } from "./common.ts";

export const ERROR_CODES = [
  "BAD_REQUEST",
  "OFFER_INVALID",
  "NOT_AUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "STALE_OFFER",
  "OFFER_EXPIRED",
  "NOT_IMPLEMENTED",
  "UPSTREAM_FAILED",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
    nextDeliveryDate: DateSchema.optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  OFFER_INVALID: 400,
  NOT_AUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_OFFER: 409,
  OFFER_EXPIRED: 409,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_FAILED: 502,
};
