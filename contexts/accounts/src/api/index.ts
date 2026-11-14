import { AccountSchema } from "@app/contract";
import { principalOf } from "@app/contract/server";
import { badRequestEnvelope, type ContextModule } from "@app/server-kit";
import { Elysia } from "elysia";

export const createApi = () =>
  new Elysia({ prefix: "/accounts" })
    .use(badRequestEnvelope())
    .get("/current", { response: { 200: AccountSchema } }, async ({ request }) => {
      const principal = await principalOf(request.headers);
      if (!principal.ok) throw new Error("The first build always has a principal (SPEC-002).");
      return principal.value;
    });

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "accounts", api: createApi };
