import { defineConfig } from "vite-plus";

const layer = (name: string) => `**/${name}/**`;
const forbid = (message: string, group: string[]) => ({ group, message });

const serverOnly = ["elysia", "drizzle-orm", "drizzle-orm/*", "bun", "bun:sql", "@app/server-kit"];
const browserOnly = ["react", "react-dom", "react-dom/*", "@tanstack/*", "@app/web-kit", "@app/ui"];
const otherContexts = {
  regex: "^(\\.\\./){3,}|/contexts/",
  message:
    "A context must not reach into another context's files. Import its public `@ctx/<name>/api` types instead.",
};

type Pattern = (ReturnType<typeof forbid> | typeof otherContexts) & { allowTypeImports?: boolean };
const restrict = (
  patterns: Pattern[],
): { "no-restricted-imports": ["error", { patterns: Pattern[] }] } => ({
  "no-restricted-imports": ["error", { patterns: [...patterns, otherContexts] }],
});
const boundary = (files: string, patterns: Pattern[]) => ({
  files: [`contexts/*/src/${files}/**`],
  rules: restrict(patterns),
});

export default defineConfig({
  staged: { "*": "vp check --fix" },
  fmt: {
    ignorePatterns: ["contexts/*/migrations/**", ".agents/skills/elysiajs/**", "skills-lock.json"],
  },
  lint: {
    ignorePatterns: ["contexts/*/migrations/**"],
    options: { typeAware: true, denyWarnings: true },
    plugins: ["typescript", "unicorn", "oxc", "import", "react", "node"],
    jsPlugins: ["@shadcn/lint"],
    settings: {
      shadcn: {
        ui: "@app/ui",
        themeImports: ["^@app/ui/"],
        note: "See DESIGN.md for the tokens, components and rules.",
      },
    },
    categories: { correctness: "error", suspicious: "error", perf: "error" },
    rules: {
      "no-console": ["error", { allow: ["log", "error"] }],
      "import/no-cycle": "error",
      "import/no-unassigned-import": ["error", { allow: ["**/*.css"] }],
      "react/react-in-jsx-scope": "off",
      "no-await-in-loop": "off",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/consistent-type-imports": "error",
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-inline-styles": "error",
      "shadcn/no-unknown-classes": "error",
      "shadcn/require-static-classes": "error",
      "shadcn/no-restyle": ["error", { allow: ["layout"] }],
    },
    overrides: [
      { files: ["packages/ui/src/**"], rules: { "shadcn/no-restyle": "off" } },
      {
        files: ["contexts/**"],
        rules: { "node/no-process-env": "error" },
      },
      {
        files: ["contexts/*/src/ui/**"],
        rules: {
          "react/forbid-elements": [
            "error",
            {
              forbid: ["button", "input", "textarea", "select", "dialog", "table"].map(
                (element) => ({
                  element,
                  message: "Use the matching component from @app/ui.",
                }),
              ),
            },
          ],
        },
      },
      boundary("domain", [
        forbid("domain is pure: it may import only `@app/kernel` and other domain files.", [
          layer("application"),
          layer("infra"),
          layer("api"),
          layer("ui"),
          ...serverOnly,
          ...browserOnly,
        ]),
      ]),
      boundary("application", [
        forbid(
          "application may import only domain and `@app/kernel`. Define a port and implement it in infra.",
          [layer("infra"), layer("api"), layer("ui"), ...serverOnly, ...browserOnly],
        ),
      ]),
      boundary("infra", [
        forbid("infra implements application ports. It must not import api, ui or browser code.", [
          layer("api"),
          layer("ui"),
          "elysia",
          ...browserOnly,
        ]),
      ]),
      boundary("api", [
        forbid("api must not import ui or browser code.", [layer("ui"), ...browserOnly]),
      ]),
      boundary("ui", [
        forbid(
          "ui talks to the server only through the Eden client. No application, infra or server imports.",
          [layer("application"), layer("infra"), ...serverOnly],
        ),
        {
          ...forbid("ui may import only types from api (`import type`).", [layer("api")]),
          allowTypeImports: true,
        },
      ]),
    ],
  },
});
