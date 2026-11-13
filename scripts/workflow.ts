import { fail } from "./lib.ts";
import { decodeRepository } from "./workflow-decode.ts";

export async function command(program: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn([program, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) fail(`${program} ${args.join(" ")} failed:\n${err.trim() || out.trim()}`);
  return out.trim();
}

export async function ghJson<T>(decode: (value: unknown) => T, ...args: string[]): Promise<T> {
  const value: unknown = JSON.parse(await command("gh", ...args));
  return decode(value);
}

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
}

export async function repository(): Promise<{
  nameWithOwner: string;
  owner: { login: string };
  name: string;
}> {
  return ghJson(decodeRepository, "repo", "view", "--json", "nameWithOwner,owner,name");
}
