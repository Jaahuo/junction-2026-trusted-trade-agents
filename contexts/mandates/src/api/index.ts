import {
  EmptySchema,
  ErrorEnvelopeSchema,
  MandateRefSchema,
  type Principal,
  RegisterMandateRequestSchema,
  StoredMandateSchema,
} from "@app/contract";
import { principalOf } from "@app/contract/server";
import { badRequestEnvelope, type ContextModule, type Db } from "@app/server-kit";
import { Elysia } from "elysia";
import {
  currentMandate,
  type MandateSigner,
  type MandateStore,
  registerMandate,
  revokeMandate,
} from "../application/mandates.ts";
import { buyerSigner } from "../infra/buyer-key.ts";
import { postgresMandateStore } from "../infra/mandate-store.ts";
import { seed } from "./seed.ts";

const principalFrom = async (request: Request): Promise<Principal> => {
  const principal = await principalOf(request.headers);
  if (!principal.ok) throw new Error("The first build always has a principal (SPEC-002).");
  return principal.value;
};

const notFound = (message: string) => ({ error: { code: "NOT_FOUND" as const, message } });

const found = { 200: StoredMandateSchema, 404: ErrorEnvelopeSchema };

export const createApi = (
  db: Db,
  now: () => Date = () => new Date(),
  sign: MandateSigner = buyerSigner(),
) => {
  const store: MandateStore = postgresMandateStore(db);
  return new Elysia({ prefix: "/mandates" })
    .use(badRequestEnvelope())
    .get("/current", { response: found }, async ({ request, status }) => {
      const result = await currentMandate(store, await principalFrom(request), now());
      return result.ok ? result.value : status(404, notFound("No current mandate."));
    })
    .post(
      "/",
      {
        body: RegisterMandateRequestSchema,
        response: { 200: StoredMandateSchema, 201: StoredMandateSchema },
      },
      async ({ body, request, status }) => {
        const { stored, replayed } = await registerMandate(
          { store, sign },
          await principalFrom(request),
          body,
          now(),
        );
        return replayed ? stored : status(201, stored);
      },
    )
    .post(
      "/:mandateId/revoke",
      { params: MandateRefSchema, body: EmptySchema.optional(), response: found },
      async ({ params, request, status }) => {
        const result = await revokeMandate(store, await principalFrom(request), params.mandateId);
        return result.ok ? result.value : status(404, notFound("No such mandate."));
      },
    );
};

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "mandates", api: createApi, seed };
