import {
  ErrorEnvelopeSchema,
  OffersRequestSchema,
  OffersResultSchema,
  RequoteRequestSchema,
  ValidateRequestSchema,
  ValidateResultSchema,
} from "@app/contract";
import { badRequestEnvelope, type ContextModule, notImplemented } from "@app/server-kit";
import { Elysia } from "elysia";

// Typed stubs of SPEC-003; the offers issue replaces them.
export const createApi = () =>
  new Elysia({ prefix: "/offers" })
    .use(badRequestEnvelope())
    .post(
      "/",
      {
        body: OffersRequestSchema,
        response: { 200: OffersResultSchema, 501: ErrorEnvelopeSchema },
      },
      ({ status }) => status(501, notImplemented("offers")),
    )
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

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "offers", api: createApi };
