import { $ } from "bun";
import { contextNames } from "./lib.ts";

const only = process.argv[2];
for (const name of contextNames()) {
  const schema = `contexts/${name}/src/infra/schema.ts`;
  if ((only !== undefined && only !== name) || !(await Bun.file(schema).exists())) continue;
  await $`bunx drizzle-kit generate --dialect postgresql --schema ${schema} --out contexts/${name}/migrations`.quiet();
}
