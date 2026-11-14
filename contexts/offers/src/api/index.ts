import { type ContextModule, env } from "@app/server-kit";
import { defaultOffersDeps } from "./adapters.ts";
import { createApi, createRoot } from "./routes.ts";

// SPEC-006: in production a missing signing key stops the server from starting.
if (env("NODE_ENV") === "production") await defaultOffersDeps().signer.jwks();

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = {
  name: "offers",
  api: () => createApi(defaultOffersDeps()),
  root: () => createRoot(defaultOffersDeps()),
};
