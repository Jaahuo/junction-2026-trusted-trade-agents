import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { VIEWS } from "@app/contract";
import { type ContextModule, contextsDir, publicBaseUrl } from "@app/server-kit";
import { Elysia, status, t } from "elysia";
import { harnessIndex, inject } from "./harness.ts";

export type ViewFiles = { dist: string; fixtures: string };

const viewFiles: ViewFiles = {
  dist: resolve(contextsDir, "views/dist"),
  fixtures: resolve(contextsDir, "views/fixtures"),
};

const isView = (name: string) => VIEWS.some((entry) => entry.view === name);

const notFound = (message: string) =>
  status(404, { error: { code: "NOT_FOUND" as const, message } });

const htmlResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

/** The fixture names of a view: its JSON files, plus `loading`, which needs no file. */
async function fixtureNames(files: ViewFiles, view: string) {
  const entries = await readdir(resolve(files.fixtures, view)).catch(() => []);
  const names = entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  return ["loading", ...names.toSorted()];
}

// Views (SPEC-013) have no /api routes; they are served at /views through `root`.
export const createApi = () => new Elysia({ prefix: "/views" });

/**
 * `GET /views/:view` serves the built view with the server's base URL written in.
 * `GET /views/harness?view=&state=` serves it with a fixture as the tool result;
 * without `state` it shows every state of one view (or of all views) side by side.
 */
export const createRoot = (files: ViewFiles = viewFiles, baseUrl: () => string = publicBaseUrl) => {
  const page = async (view: string, fixture?: unknown) => {
    if (!isView(view)) return notFound(`There is no view ${view}.`);
    const file = Bun.file(resolve(files.dist, `${view}.html`));
    if (!(await file.exists()))
      return notFound(`The view ${view} is not built. Run \`bun run build\`.`);
    return htmlResponse(inject(await file.text(), baseUrl(), fixture));
  };
  return new Elysia({ prefix: "/views" })
    .get(
      "/harness",
      { query: t.Object({ view: t.Optional(t.String()), state: t.Optional(t.String()) }) },
      async ({ query: { view, state } }) => {
        if (view !== undefined && !isView(view)) return notFound(`There is no view ${view}.`);
        if (state === undefined) {
          const views = view === undefined ? VIEWS.map((entry) => entry.view) : [view];
          const states = await Promise.all(
            views.map(async (name) => ({ view: name, states: await fixtureNames(files, name) })),
          );
          return htmlResponse(harnessIndex(states));
        }
        if (view === undefined) return notFound("Name a view with `view=`.");
        if (!(await fixtureNames(files, view)).includes(state))
          return notFound(`The view ${view} has no fixture ${state}.`);
        if (state === "loading") return page(view, { state: "loading" });
        const result: unknown = await Bun.file(
          resolve(files.fixtures, view, `${state}.json`),
        ).json();
        return page(view, { result });
      },
    )
    .get("/:view", ({ params }) => page(params.view));
};

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "views", api: createApi, root: () => createRoot() };
