import { $ } from "bun";
import { existsSync } from "node:fs";
import { fail } from "./lib.ts";

const [name] = process.argv.slice(2);
if (name === undefined || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
  fail(
    "Usage: bun run new:context <name>   (lowercase letters and digits, separated by single dashes)",
  );
}
if (existsSync(`contexts/${name}`)) fail(`contexts/${name} already exists.`);

const title = name.replaceAll(/(^|-)([a-z0-9])/g, (_, __, char: string) => char.toUpperCase());
const files: Record<string, string> = {
  "package.json": JSON.stringify({
    name: `@ctx/${name}`,
    private: true,
    type: "module",
    exports: { "./api": "./src/api/index.ts", "./ui": "./src/ui/index.tsx" },
    dependencies: {
      "@app/server-kit": "workspace:*",
      "@app/ui": "workspace:*",
      "@app/web-kit": "workspace:*",
      elysia: "catalog:",
      react: "catalog:",
    },
  }),
  "src/api/index.ts": `
    import type { ContextModule } from "@app/server-kit";
    import { Elysia } from "elysia";

    export const createApi = () =>
      new Elysia({ prefix: "/${name}" }).get("/", () => ({ context: "${name}" }));

    export type Api = ReturnType<typeof createApi>;

    export const context: ContextModule = { name: "${name}", api: createApi };
  `,
  "src/api/index.test.ts": `
    import { expect, test } from "bun:test";
    import { createApi } from "./index.ts";

    test("the ${name} context answers", async () => {
      const app = createApi();
      const response = await app.handle(new Request("http://localhost/${name}"));
      expect(await response.json()).toEqual({ context: "${name}" });
    });
  `,
  "src/ui/index.tsx": `
    import { EmptyState, PageHeader } from "@app/ui";
    import type { Screen } from "@app/web-kit";

    function ${title}Screen() {
      return (
        <>
          <PageHeader title="${title}" />
          <EmptyState title="Nothing here yet" description="Build this screen from @app/ui components." />
        </>
      );
    }

    export const screen: Screen = { path: "/${name}", title: "${title}", Component: ${title}Screen };
  `,
};

await Promise.all(
  Object.entries(files).map(async ([file, content]) =>
    Bun.write(`contexts/${name}/${file}`, content),
  ),
);
await $`bun install`.quiet();
await $`bunx vp check --fix ${`contexts/${name}`}`.quiet();
console.log(
  `created contexts/${name}. Add domain, application and infra by following contexts/notes, then run \`bun run gate\`.`,
);
