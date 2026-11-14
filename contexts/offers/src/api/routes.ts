import {
  AvailabilityRequestSchema,
  AvailabilityResultSchema,
  ErrorEnvelopeSchema,
  IssuedOffersRequestSchema,
  IssuedOffersSchema,
  OffersRequestSchema,
  OffersResultSchema,
  RequoteRequestSchema,
  ValidateRequestSchema,
  ValidateResultSchema,
} from "@app/contract";
import { principalOf } from "@app/contract/server";
import { badRequestEnvelope, notImplemented } from "@app/server-kit";
import { Elysia } from "elysia";
import { deliverableBy } from "../application/availability.ts";
import { getOffers } from "../application/get-offers.ts";
import type { OffersDeps } from "../application/ports.ts";
import { requote } from "../application/requote.ts";
import { ownOfferClaims } from "../infra/own-offer-claims.ts";

const principalFrom = async (request: Request) => {
  const principal = await principalOf(request.headers);
  if (!principal.ok) throw new Error("The first build always has a principal (SPEC-002).");
  return principal.value;
};

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
        const result = await getOffers(deps, await principalFrom(request), body);
        if (result.ok) return result.value;
        const { code, message } = result.error;
        return code === "BAD_REQUEST"
          ? status(400, { error: { code, message } })
          : status(502, { error: { code, message } });
      },
    )
    .post(
      "/requote",
      {
        body: RequoteRequestSchema,
        response: { 200: OffersResultSchema, 400: ErrorEnvelopeSchema, 502: ErrorEnvelopeSchema },
      },
      async ({ body, request, status }) => {
        const result = await requote(
          deps,
          await principalFrom(request),
          body,
          ownOfferClaims(deps.signer, deps.now),
        );
        if (result.ok) return result.value;
        const { code, message } = result.error;
        return code === "BAD_REQUEST"
          ? status(400, { error: { code, message } })
          : status(502, { error: { code, message } });
      },
    )
    .post(
      "/issued",
      { body: IssuedOffersRequestSchema, response: { 200: IssuedOffersSchema } },
      async ({ body, request }) => ({
        offers: deps.issued.find(await principalFrom(request), body.offerIds, deps.now()),
      }),
    )
    .post(
      "/availability",
      {
        body: AvailabilityRequestSchema,
        response: { 200: AvailabilityResultSchema, 502: ErrorEnvelopeSchema },
      },
      async ({ body, request, status }) => {
        const result = await deliverableBy(deps, await principalFrom(request), body);
        return result.ok
          ? result.value
          : status(502, {
              error: { code: result.error, message: "live availability could not be read" },
            });
      },
    )
    // Typed stub of SPEC-003 until its issue builds it.
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
