import { $ } from "bun";
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

await Bun.write(`${out}/entry.ts`, entry);
await Promise.all([
  $`bunx vp build`.cwd("apps/web").quiet(),
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
