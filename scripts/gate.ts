import { $ } from "bun";
import { fail } from "./lib.ts";

const secrets = async () =>
  Bun.which("gitleaks") === null
    ? { exitCode: 1, text: "gitleaks is not installed. Run `mise install`." }
    : capture($`gitleaks git --redact --no-banner`);

const steps: [name: string, run: () => Promise<{ exitCode: number; text: string }>][] = [
  ["secrets (gitleaks)", secrets],
  ["types", () => capture($`bun check`)],
  ["format, lint", () => capture($`bunx vp check`)],
  ["tests", () => capture($`bun test`)],
  ["unused code (knip)", () => capture($`bunx knip`)],
  ["duplication (jscpd)", () => capture($`bunx jscpd`)],
  ["migrations match schema", migrationsMatchSchema],
  [
    "production build (web and compiled API)",
    () => capture($`bun scripts/production.ts --build-only`),
  ],
];

async function capture(command: ReturnType<typeof $>) {
  const result = await command.nothrow().quiet();
  return {
    exitCode: result.exitCode,
    text: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

async function migrationDigest() {
  const digest = new Bun.CryptoHasher("sha256");
  const paths = [
    ...new Bun.Glob("contexts/*/migrations/**/*").scanSync({ onlyFiles: true }),
  ].toSorted();
  for (const path of paths) {
    digest.update(path);
    digest.update(await Bun.file(path).arrayBuffer());
  }
  return digest.digest("hex");
}

async function migrationsMatchSchema() {
  const before = await migrationDigest();
  const generated = await capture($`bun scripts/db-generate.ts`);
  if (generated.exitCode !== 0) return generated;
  return before === (await migrationDigest())
    ? { exitCode: 0, text: "" }
    : {
        exitCode: 1,
        text: "Schema changed without a migration. Review the generated migrations and run the gate again.",
      };
}

const started = performance.now();
for (const [name, run] of steps) {
  const stepStarted = performance.now();
  const { exitCode, text } = await run();
  const seconds = ((performance.now() - stepStarted) / 1000).toFixed(1);
  if (exitCode !== 0) {
    console.error(text);
    fail(`gate failed at: ${name} (${seconds}s)`);
  }
  console.log(`✓ ${name} (${seconds}s)`);
}
console.log(`gate passed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
