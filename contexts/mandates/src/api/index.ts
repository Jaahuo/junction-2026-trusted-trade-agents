import {
  EmptySchema,
  ErrorEnvelopeSchema,
  MandateRefSchema,
  RegisterMandateRequestSchema,
  StoredMandateSchema,
} from "@app/contract";
import { badRequestEnvelope, type ContextModule, notImplemented } from "@app/server-kit";
import { Elysia } from "elysia";

const responses = { 200: StoredMandateSchema, 501: ErrorEnvelopeSchema };

// Typed stubs of SPEC-003; the mandates issue replaces them.
export const createApi = () =>
  new Elysia({ prefix: "/mandates" })
    .use(badRequestEnvelope())
    .get("/current", { response: responses }, ({ status }) =>
      status(501, notImplemented("mandate")),
    )
    .post(
      "/",
      {
        body: RegisterMandateRequestSchema,
        response: { ...responses, 201: StoredMandateSchema },
      },
      ({ status }) => status(501, notImplemented("register")),
    )
    .post(
      "/:mandateId/revoke",
      { params: MandateRefSchema, body: EmptySchema.optional(), response: responses },
      ({ status }) => status(501, notImplemented("revoke")),
    );

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "mandates", api: createApi };
