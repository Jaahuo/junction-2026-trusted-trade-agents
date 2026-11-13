import { $ } from "bun";

export const contextNames = (): string[] =>
  [...new Bun.Glob("*/package.json").scanSync("contexts")]
    .map((file) => file.split("/")[0] ?? "")
    .toSorted();

export const git = async (...args: string[]): Promise<{ ok: boolean; out: string }> => {
  const result = await $`git ${args}`.nothrow().quiet();
  return {
    ok: result.exitCode === 0,
    out: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
};

export function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
