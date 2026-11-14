import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

async function publicationScript(): Promise<string> {
  const workflow: unknown = Bun.YAML.parse(
    await Bun.file(`${import.meta.dir}/../.github/workflows/deploy.yml`).text(),
  );
  const steps = field(field(field(workflow, "jobs"), "publish"), "steps");
  if (!Array.isArray(steps)) throw new Error("Missing publication job");
  const step: unknown = steps.find(
    (value: unknown) => field(value, "name") === "Publish verified images",
  );
  const script = field(step, "run");
  if (typeof script !== "string") throw new Error("Missing publication program");
  return script;
}

const digest = (text: string) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
const config = (letter: string) => `sha256:${letter.repeat(64)}`;

async function publish(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "publish-image-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    await mkdir(join(root, "deployment-evidence"));
    const manifests = {
      api: JSON.stringify({ config: { digest: config("a") } }),
      chat: JSON.stringify({ config: { digest: config(mode === "config" ? "c" : "b") } }),
    };
    for (const [name, body] of Object.entries(manifests)) {
      await writeFile(join(root, `${name}.json`), body);
      const hash = mode === "hash" && name === "chat" ? config("d") : digest(body);
      await writeFile(join(root, `${name}.headers`), `Docker-Content-Digest: ${hash}\r\n`);
    }
    await writeFile(
      join(root, "deployment-evidence/manifest.json"),
      JSON.stringify({ imageId: config("a"), chatImageId: config("b") }),
    );
    await writeFile(join(root, "output"), "");
    await writeFile(join(root, "chat-reads"), "0");
    const commands = {
      docker: "#!/bin/sh\nexit 0\n",
      sleep: "#!/bin/sh\nexit 0\n",
      curl: `#!/bin/sh
case "$*" in *"/token?"*) printf '{"token":"fixture"}'; exit 0;; esac
fail=false
status_output=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fail) fail=true;;
    --write-out) status_output=true; shift;;
    -D) headers=$2; shift;;
    -o) body=$2; shift;;
    https://*) url=$1;;
  esac
  shift
done
name=api
status=200
case "$url" in *-chat)
  name=chat
  count=$(cat "$FIXTURE/chat-reads")
  count=$((count + 1))
  printf '%s' "$count" > "$FIXTURE/chat-reads"
  case "$MODE" in
    eventual) if [ "$count" = 1 ]; then status=404; fi;;
    missing) status=404;;
    401|403|500) status=$MODE;;
    transport) exit 7;;
  esac
esac
cp "$FIXTURE/$name.json" "$body"
cp "$FIXTURE/$name.headers" "$headers"
if [ "$status" != 200 ] && [ "$fail" = true ]; then exit 22; fi
if [ "$status_output" = true ]; then printf '%s' "$status"; fi
`,
    };
    for (const [name, script] of Object.entries(commands)) {
      const path = join(bin, name);
      await writeFile(path, script);
      await chmod(path, 0o755);
    }
    const child = Bun.spawn(["bash", "-c", await publicationScript()], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        FIXTURE: root,
        MODE: mode,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: join(root, "output"),
        SHA: "fixture",
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        GH_TOKEN: "fixture-token",
        REGISTRY_USER: "fixture-user",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    return {
      exitCode: await child.exited,
      stderr,
      output: await readFile(join(root, "output"), "utf8"),
      reads: Number(await readFile(join(root, "chat-reads"), "utf8")),
      chatDigest: digest(manifests.chat),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a temporarily invisible chat manifest publishes its verified immutable reference", async () => {
  const result = await publish("eventual");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.reads).toBe(2);
  expect(result.output).toContain(
    `chat_image=ghcr.io/jaahuo/junction-2026-trusted-trade-agents@${result.chatDigest}\n`,
  );
});

test("a permanently absent manifest fails after bounded reads without a chat deployment reference", async () => {
  const result = await publish("missing");
  expect(result.exitCode).not.toBe(0);
  expect(result.reads).toBe(6);
  expect(result.output).not.toContain("chat_image=");
});

for (const mode of ["401", "403", "500", "transport", "hash", "config"]) {
  test(`publication fails closed without retrying ${mode}`, async () => {
    const result = await publish(mode);
    expect(result.exitCode).not.toBe(0);
    expect(result.reads).toBe(1);
    expect(result.output).not.toContain("chat_image=");
  });
}
