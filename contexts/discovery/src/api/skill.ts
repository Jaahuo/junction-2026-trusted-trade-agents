import { resolve } from "node:path";
import { ErrorEnvelopeSchema } from "@app/contract";
import { env } from "@app/server-kit";
import { Elysia } from "elysia";

// The compiled production binary finds the repo files through APP_ROOT.
const skillDir = resolve(
  env("APP_ROOT") ?? resolve(import.meta.dir, "../../../.."),
  "skills/trusted-trade-ordering",
);
const names = new Set(["SKILL.md", "reason-codes.md"]);

export const skillRoutes = () =>
  new Elysia({ prefix: "/skills/trusted-trade-ordering" }).get(
    "/:file",
    { response: { 404: ErrorEnvelopeSchema } },
    ({ params, status }) => {
      if (!names.has(params.file))
        return status(404, {
          error: { code: "NOT_FOUND" as const, message: `Unknown skill file: ${params.file}.` },
        });
      return new Response(Bun.file(resolve(skillDir, params.file)), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${params.file}"`,
        },
      });
    },
  );
