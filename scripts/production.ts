import { $ } from "bun";
import { rm } from "node:fs/promises";
import { contextNames } from "./lib.ts";
import { loadRuntime } from "./runtime.ts";

const out = "apps/api/.production";
const names = contextNames();
const entry = [
  ...names.map(
    (name, index) =>
      `import { context as c${index} } from "../../../contexts/${name}/src/api/index.ts";`,
  ),
  `import { serve } from "../src/server.ts";`,
  `await serve([${names.map((_, index) => `c${index}`).join(", ")}]);`,
].join("\n");

// Each view is one self-contained HTML file in contexts/views/dist (SPEC-013).
const viewsDir = "contexts/views";
const views = [...new Bun.Glob("*.html").scanSync(`${viewsDir}/src/views`)].map((file) =>
  file.replace(/\.html$/, ""),
);

await Bun.write(`${out}/entry.ts`, entry);
await rm(`${viewsDir}/dist`, { recursive: true, force: true });
await Promise.all([
  $`bunx vp build`.cwd("apps/web").quiet(),
  ...views.map(async (view) => $`bunx vp build --mode ${view}`.cwd(viewsDir).quiet()),
  $`bun build --compile --minify-whitespace --minify-syntax --target bun --outfile ${out}/server ${out}/entry.ts`.quiet(),
]);
if (!process.argv.includes("--build-only")) {
  await loadRuntime();
  await $`${out}/server`.env({
    ...process.env,
    NODE_ENV: "production",
    APP_ROOT: process.cwd(),
    WEB_DIST: "apps/web/dist",
  });
}
