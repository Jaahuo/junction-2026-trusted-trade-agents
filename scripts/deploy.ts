import { $ } from "bun";
import { existsSync } from "node:fs";
import { configure, waitUntilUp } from "./openwebui.ts";

// Deploys an immutable image to the Vultr host that infra/ creates. See docs/deploy.md.

export interface Outputs {
  readonly public_ip: string;
  readonly hostname: string;
  readonly public_base_url: string;
  readonly app_dir: string;
  readonly app_port: number;
  readonly database_url: string;
}

const SECRETS_FILE = process.env["DEPLOY_ENV_FILE"] ?? ".env.deploy";
const SECRET_NAMES = ["OFFER_SIGNING_JWK", "OFFER_SIGNING_KID", "BUYER_SIGNING_JWK"] as const;
const PRIVATE_KEYS = ["OFFER_SIGNING_JWK", "BUYER_SIGNING_JWK"] as const;

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

/** Signs a probe with the private key and verifies it with its public part: the key imports and its halves match. */
const isUsableSigningKey = async (text: string): Promise<boolean> => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return false;
    const jwk: JsonWebKey = parsed;
    const { d: _d, key_ops: _ops, ...publicJwk } = jwk;
    const signer = await crypto.subtle.importKey("jwk", jwk, P256, false, ["sign"]);
    const verifier = await crypto.subtle.importKey("jwk", publicJwk, P256, false, ["verify"]);
    const probe = new TextEncoder().encode("deploy-key-probe");
    const signature = await crypto.subtle.sign(ES256, signer, probe);
    return await crypto.subtle.verify(ES256, verifier, signature, probe);
  } catch {
    return false;
  }
};

export const parseEnv = (text: string): Map<string, string> =>
  new Map(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        if (at < 1) throw new Error(`${SECRETS_FILE}: not KEY=VALUE: ${line.slice(0, 20)}`);
        return [line.slice(0, at), line.slice(at + 1).replace(/^(['"])(.*)\1$/, "$2")] as const;
      }),
  );

/** The hosted environment: the signing keys and settings that both the server and a reset use. */
export const deployEnv = async (
  outputs: Outputs,
  secrets: ReadonlyMap<string, string>,
): Promise<Map<string, string>> => {
  const missing = SECRET_NAMES.filter((name) => (secrets.get(name) ?? "").trim() === "");
  if (missing.length > 0)
    throw new Error(
      `${SECRETS_FILE} lacks ${missing.join(", ")}. Run: bun scripts/generate-keys.ts > ${SECRETS_FILE}`,
    );
  const usable = await Promise.all(
    PRIVATE_KEYS.map((name) => isUsableSigningKey(secrets.get(name) ?? "")),
  );
  const invalid = PRIVATE_KEYS.filter((_, index) => usable[index] !== true);
  if (invalid.length > 0)
    throw new Error(`${SECRETS_FILE}: ${invalid.join(", ")} must be a private P-256 JWK`);
  return new Map<string, string>([
    ...secrets,
    ["NODE_ENV", "production"],
    ["PORT", "3000"],
    ["APP_ROOT", "/app"],
    ["WEB_DIST", "apps/web/dist"],
    ["PUBLIC_BASE_URL", outputs.public_base_url],
    ["DATABASE_URL", outputs.database_url],
  ]);
};

/** Docker's env-file syntax takes the value literally, without shell quotes. */
export const renderEnvFile = (values: ReadonlyMap<string, string>): string =>
  `${[...values]
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(value))
        throw new Error(`Invalid environment entry: ${name}`);
      return `${name}=${value}`;
    })
    .join("\n")}\n`;

const site = (hostname: string, port: number): string =>
  `${hostname} {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:${port}\n}\n`;

export const renderCaddyfile = (outputs: Outputs, chat = false): string =>
  site(outputs.hostname, outputs.app_port) +
  (chat ? `\n${site(chatHostname(outputs), CHAT_PORT)}` : "");

// Open WebUI as the hosted chat host (#155). It runs only when VERDA_INFERENCE_KEY is set.
const CHAT_IMAGE = "ghcr.io/open-webui/open-webui:v0.13.3";
const CHAT_PORT = 8080;
const CHAT_MODEL_URL = "https://containers.datacrunch.io/nemotron-3-5-super-vl-b300/v1";
const CHAT_BASE_MODEL = "nemotron-3.5-super-vl";
const CHAT_SECRETS = [
  "OPENWEBUI_SECRET_KEY",
  "OPENWEBUI_ADMIN_EMAIL",
  "OPENWEBUI_ADMIN_PASSWORD",
] as const;

/** Open WebUI needs a host of its own, because it does not run under a path prefix. */
export const chatHostname = (outputs: Outputs): string => `chat.${outputs.hostname}`;

export interface Chat {
  readonly inferenceKey: string;
  readonly secretKey: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
}

/** The chat settings, or undefined when VERDA_INFERENCE_KEY is unset and the deploy skips the chat host. */
export const chatSettings = (
  settings: Readonly<Record<string, string | undefined>>,
): Chat | undefined => {
  const inferenceKey = (settings["VERDA_INFERENCE_KEY"] ?? "").trim();
  if (inferenceKey === "") return undefined;
  const value = (name: (typeof CHAT_SECRETS)[number]): string => (settings[name] ?? "").trim();
  const missing = CHAT_SECRETS.filter((name) => value(name) === "");
  if (missing.length > 0)
    throw new Error(
      `VERDA_INFERENCE_KEY is set, so the chat host also needs ${missing.join(", ")}`,
    );
  return {
    inferenceKey,
    secretKey: value("OPENWEBUI_SECRET_KEY"),
    adminEmail: value("OPENWEBUI_ADMIN_EMAIL"),
    adminPassword: value("OPENWEBUI_ADMIN_PASSWORD"),
  };
};

/** Login on and sign-up off: the inference key pays for every chat. The admin exists after the first start. */
export const chatEnv = (outputs: Outputs, chat: Chat): Map<string, string> =>
  new Map([
    ["WEBUI_URL", `https://${chatHostname(outputs)}`],
    ["WEBUI_AUTH", "True"],
    ["ENABLE_SIGNUP", "False"],
    ["ENABLE_OLLAMA_API", "False"],
    ["WEBUI_SECRET_KEY", chat.secretKey],
    ["WEBUI_ADMIN_EMAIL", chat.adminEmail],
    ["WEBUI_ADMIN_PASSWORD", chat.adminPassword],
    ["OPENAI_API_BASE_URL", CHAT_MODEL_URL],
    ["OPENAI_API_KEY", chat.inferenceKey],
  ]);

export const CHAT_SERVICE = `[Unit]
Description=Trusted trade chat host (Open WebUI)
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service
ConditionPathExists=/etc/trusted-trade-chat.env

[Service]
ExecStart=/usr/bin/docker run --rm --name trusted-trade-chat --pull=never --env-file /etc/trusted-trade-chat.env -p 127.0.0.1:${CHAT_PORT}:8080 -v trusted-trade-chat:/app/backend/data ${CHAT_IMAGE}
ExecStop=/usr/bin/docker stop --time 30 trusted-trade-chat
TimeoutStopSec=40
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

const SSH = ["-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes"];

/** Parses `tofu output -json`; CI passes the same JSON in DEPLOY_OUTPUTS because it has no state. */
export const parseOutputs = (json: string): Outputs => {
  const raw: unknown = JSON.parse(json);
  const value = (name: keyof Outputs): unknown => {
    const entry: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, name) : null;
    if (typeof entry !== "object" || entry === null || !("value" in entry))
      throw new Error(`tofu output ${name} is missing; run tofu apply`);
    return entry.value;
  };
  return {
    public_ip: String(value("public_ip")),
    hostname: String(value("hostname")),
    public_base_url: String(value("public_base_url")),
    app_dir: String(value("app_dir")),
    app_port: Number(value("app_port")),
    database_url: String(value("database_url")),
  };
};

const readOutputs = async (): Promise<Outputs> =>
  parseOutputs(process.env["DEPLOY_OUTPUTS"] ?? (await $`tofu -chdir=infra output -json`.text()));

const waitForHealth = async (url: string): Promise<void> => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) {
      console.log(`healthy: ${url}/api/health`);
      return;
    }
    console.log(`waiting for ${url}/api/health`);
    await Bun.sleep(3000);
  }
  throw new Error(
    `${url}/api/health did not answer 200 within three minutes. Check: ssh root@<ip> journalctl -u trusted-trade -u caddy -n 50`,
  );
};

/** The app secrets: DEPLOY_ENV in CI, else the ignored local file. */
const loadDeployEnv = async (outputs: Outputs): Promise<Map<string, string>> => {
  const inline = process.env["DEPLOY_ENV"];
  if (inline === undefined && !existsSync(SECRETS_FILE))
    throw new Error(`Create ${SECRETS_FILE}: bun scripts/generate-keys.ts > ${SECRETS_FILE}`);
  return deployEnv(outputs, parseEnv(inline ?? (await Bun.file(SECRETS_FILE).text())));
};

/** A reset runs here, with the hosted keys, against the checkout's own contexts. */
export const resetEnv = (
  hosted: ReadonlyMap<string, string>,
  local: Readonly<Record<string, string | undefined>>,
  checkout: string,
): Record<string, string | undefined> => ({
  ...local,
  ...Object.fromEntries(hosted),
  APP_ROOT: checkout,
});

const IMAGE_REPOSITORY = "ghcr.io/jaahuo/junction-2026-trusted-trade-agents";
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const renderService = (outputs: Outputs): string => {
  if (!outputs.app_dir.startsWith("/") || /[:\r\n]/.test(outputs.app_dir))
    throw new Error("app_dir must be an absolute path without colons or newlines");
  if (!Number.isInteger(outputs.app_port) || outputs.app_port < 1 || outputs.app_port > 65535)
    throw new Error("Invalid app_port");
  const mount = `${outputs.app_dir}/data:/app/data:ro`
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$");
  return `[Unit]
Description=Trusted trade agents API
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service
ConditionPathExists=/etc/trusted-trade.env
ConditionPathExists=/etc/trusted-trade-image.env

[Service]
EnvironmentFile=/etc/trusted-trade-image.env
ExecStart=/usr/bin/docker run --rm --name trusted-trade --pull=never --env-file /etc/trusted-trade.env -p 127.0.0.1:${outputs.app_port}:3000 -v "${mount}" \${TRUSTED_TRADE_IMAGE}
ExecStop=/usr/bin/docker stop --time 30 trusted-trade
TimeoutStopSec=40
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
};

export const transferData = async (
  source: string,
  host: string,
  appDir: string,
  remoteShell: string,
): Promise<void> => {
  await $`rsync -az -e ${remoteShell} ${source} ${`${host}:${appDir}/data/`}`;
};

export const push = async (
  outputs: Outputs,
  settings: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> => {
  const image = settings["DEPLOY_IMAGE"] ?? "";
  if (!new RegExp(`^${IMAGE_REPOSITORY.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`).test(image))
    throw new Error("DEPLOY_IMAGE must be the trusted GHCR repository pinned by sha256 digest");
  const user = settings["DEPLOY_REGISTRY_USER"] ?? "";
  const token = settings["DEPLOY_REGISTRY_TOKEN"] ?? "";
  if (!user || !token || /[\r\n]/.test(user) || /[\r\n]/.test(token))
    throw new Error("DEPLOY_REGISTRY_USER and DEPLOY_REGISTRY_TOKEN are required");
  const unit = renderService(outputs);
  const envFile = renderEnvFile(await loadDeployEnv(outputs));
  const chat = chatSettings(settings);
  const host = `root@${outputs.public_ip}`;
  const dir = shellQuote(outputs.app_dir);
  await $`ssh ${SSH} ${host} cloud-init status --wait`.quiet();
  await $`ssh ${SSH} ${host} ${`set -eu; if ! command -v docker >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io; fi; systemctl enable --now docker; mkdir -p ${dir}/data`}`;
  const pull = `set -eu
config=$(mktemp -d)
trap 'rm -rf "$config"' EXIT
export DOCKER_CONFIG="$config"
docker login ghcr.io --username ${shellQuote(user)} --password-stdin >&2
docker pull ${shellQuote(image)} >&2
docker image inspect --format '{{.Id}}' ${shellQuote(image)}
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' ${shellQuote(image)}
`;
  const [expectedImageId, ...digests] = (
    await $`ssh ${SSH} ${host} ${pull} < ${new Response(token)}`.text()
  )
    .trim()
    .split("\n");
  if (expectedImageId === undefined || !/^sha256:[0-9a-f]{64}$/.test(expectedImageId))
    throw new Error("Pulled image has an invalid SHA-256 image ID");
  if (!digests.includes(image))
    throw new Error("Pulled image does not contain the requested repository digest");
  const remoteShell = `ssh ${SSH.join(" ")}`;
  if (existsSync("data")) await transferData("data/", host, outputs.app_dir, remoteShell);
  // Everything slow or network-bound for the chat host happens before the app stops.
  if (chat) {
    await $`ssh ${SSH} ${host} docker pull --quiet ${CHAT_IMAGE}`;
    await $`ssh ${SSH} ${host} install -m 600 /dev/stdin /etc/trusted-trade-chat.env < ${new Response(renderEnvFile(chatEnv(outputs, chat)))}`;
    await $`ssh ${SSH} ${host} install -m 644 /dev/stdin /etc/systemd/system/trusted-trade-chat.service < ${new Response(CHAT_SERVICE)}`;
  }
  await $`ssh ${SSH} ${host} systemctl stop trusted-trade`;
  await $`ssh ${SSH} ${host} ${`chown -R 1000:1000 ${dir}/data && chmod -R u+rX ${dir}/data`}`;
  await $`ssh ${SSH} ${host} install -m 600 /dev/stdin /etc/trusted-trade.env < ${new Response(envFile)}`;
  await $`ssh ${SSH} ${host} install -m 600 /dev/stdin /etc/trusted-trade-image.env < ${new Response(`TRUSTED_TRADE_IMAGE="${image}"\n`)}`;
  await $`ssh ${SSH} ${host} install -m 644 /dev/stdin /etc/systemd/system/trusted-trade.service < ${new Response(unit)}`;
  await $`ssh ${SSH} ${host} install -m 644 /dev/stdin /etc/caddy/Caddyfile < ${new Response(renderCaddyfile(outputs, chat !== undefined))}`;
  // The Vultr Ubuntu image enables ufw with only SSH open.
  await $`ssh ${SSH} ${host} ${"ufw allow 80/tcp && ufw allow 443/tcp && systemctl daemon-reload && systemctl enable --now trusted-trade && systemctl reload caddy"}`;
  await waitForHealth(outputs.public_base_url);
  const runningImage = (
    await $`ssh ${SSH} ${host} ${"docker container inspect --format '{{.Image}} {{.State.Running}}' trusted-trade"}`.text()
  ).trim();
  if (runningImage !== `${expectedImageId} true`)
    throw new Error(
      "Running container image hash or running state does not match the expected image",
    );
  console.log(`verified container image: ${expectedImageId} (${image})`);
  if (chat) {
    // The chat restarts only after the app is healthy, so it never adds to the app's downtime.
    await $`ssh ${SSH} ${host} ${"systemctl daemon-reload && systemctl enable trusted-trade-chat && systemctl restart trusted-trade-chat"}`;
    const base = `https://${chatHostname(outputs)}`;
    await waitUntilUp(base);
    await configure({
      base,
      email: chat.adminEmail,
      password: chat.adminPassword,
      mcpUrl: `${outputs.public_base_url}/mcp`,
      openaiUrl: CHAT_MODEL_URL,
      openaiKey: chat.inferenceKey,
      baseModel: CHAT_BASE_MODEL,
    });
  } else console.log("chat host: skipped, VERDA_INFERENCE_KEY is not set");
};

const reset = async (outputs: Outputs): Promise<void> => {
  if (!process.argv.includes("--yes"))
    throw new Error("reset replaces the hosted demo data. Re-run with reset --yes.");
  const hosted = await loadDeployEnv(outputs);
  await $`bun apps/api/src/remote-reset.ts --yes`.env(resetEnv(hosted, process.env, process.cwd()));
};

if (import.meta.main) {
  const command = process.argv[2] ?? "push";
  const outputs = await readOutputs();
  if (command === "push") await push(outputs);
  else if (command === "reset") await reset(outputs);
  else if (command === "health") await waitForHealth(outputs.public_base_url);
  else throw new Error("Usage: bun scripts/deploy.ts [push | reset --yes | health]");
}
