import {
  ErrorEnvelopeSchema,
  OffersRequestSchema,
  OffersResultSchema,
  RequoteRequestSchema,
  ValidateRequestSchema,
  ValidateResultSchema,
} from "@app/contract";
import { principalOf } from "@app/contract/server";
import { badRequestEnvelope, notImplemented } from "@app/server-kit";
import { Elysia } from "elysia";
import { getOffers } from "../application/get-offers.ts";
import type { OffersDeps } from "../application/ports.ts";

export const createApi = (deps: OffersDeps) =>
  new Elysia({ prefix: "/offers" })
    .use(badRequestEnvelope())
    .post(
      "/",
      {
        body: OffersRequestSchema,
        response: { 200: OffersResultSchema, 400: ErrorEnvelopeSchema, 502: ErrorEnvelopeSchema },
      },
      async ({ body, request, status }) => {
        const principal = await principalOf(request.headers);
        if (!principal.ok) throw new Error("The first build always has a principal (SPEC-002).");
        const result = await getOffers(deps, principal.value, body);
        if (result.ok) return result.value;
        const { code, message } = result.error;
        return code === "BAD_REQUEST"
          ? status(400, { error: { code, message } })
          : status(502, { error: { code, message } });
      },
    )
    // Typed stubs of SPEC-003 until their issue builds them.
    .post(
      "/requote",
      {
        body: RequoteRequestSchema,
        response: { 200: OffersResultSchema, 501: ErrorEnvelopeSchema },
      },
      ({ status }) => status(501, notImplemented("requote")),
    )
    .post(
      "/validate",
      {
        body: ValidateRequestSchema,
        response: { 200: ValidateResultSchema, 501: ErrorEnvelopeSchema },
      },
      ({ status }) => status(501, notImplemented("validate")),
    );

export const createRoot = (deps: OffersDeps) =>
  new Elysia().get("/.well-known/jwks.json", () => deps.signer.jwks());
