import { $ } from "bun";
import { existsSync } from "node:fs";

// Ships the current worktree to the Vultr host that infra/ creates. See docs/deploy.md.

export interface Outputs {
  readonly public_ip: string;
  readonly hostname: string;
  readonly public_base_url: string;
  readonly app_dir: string;
  readonly app_port: number;
  readonly database_url: string;
}

const SECRETS_FILE = ".env.deploy";
const SECRET_NAMES = ["OFFER_SIGNING_JWK", "OFFER_SIGNING_KID", "BUYER_SIGNING_JWK"] as const;

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
export const deployEnv = (
  outputs: Outputs,
  secrets: ReadonlyMap<string, string>,
): Map<string, string> => {
  const missing = SECRET_NAMES.filter((name) => !secrets.has(name));
  if (missing.length > 0)
    throw new Error(
      `${SECRETS_FILE} lacks ${missing.join(", ")}. Run: bun scripts/generate-keys.ts > ${SECRETS_FILE}`,
    );
  return new Map<string, string>([
    ...secrets,
    ["NODE_ENV", "production"],
    ["PORT", String(outputs.app_port)],
    ["APP_ROOT", outputs.app_dir],
    ["WEB_DIST", "apps/web/dist"],
    ["PUBLIC_BASE_URL", outputs.public_base_url],
    ["DATABASE_URL", outputs.database_url],
  ]);
};

/** A systemd EnvironmentFile; single quotes keep JSON keys literal. */
export const renderEnvFile = (values: ReadonlyMap<string, string>): string => {
  return `${[...values]
    .map(([name, value]) => {
      if (/['\n]/.test(value)) throw new Error(`${name} contains a quote or a newline`);
      return `${name}='${value}'`;
    })
    .join("\n")}\n`;
};

export const renderCaddyfile = (outputs: Outputs): string =>
  `${outputs.hostname} {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:${outputs.app_port}\n}\n`;

const SSH = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"];
const RSYNC_EXCLUDES = [
  ".git",
  "node_modules",
  ".env*",
  ".local",
  "infra",
  "report",
  "apps/api/.production",
];

const readOutputs = async (): Promise<Outputs> => {
  const raw: Record<string, { value: unknown }> = await $`tofu -chdir=infra output -json`.json();
  const value = (name: keyof Outputs): unknown => {
    const entry = raw[name];
    if (entry === undefined) throw new Error(`tofu output ${name} is missing; run tofu apply`);
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

const waitForHealth = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ok = await fetch(`${url}/api/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) {
      console.log(`healthy: ${url}/api/health`);
      return;
    }
    await Bun.sleep(2000);
  }
  throw new Error(`${url}/api/health did not answer 200 within two minutes`);
};

const loadDeployEnv = async (outputs: Outputs): Promise<Map<string, string>> => {
  if (!existsSync(SECRETS_FILE))
    throw new Error(`Create ${SECRETS_FILE}: bun scripts/generate-keys.ts > ${SECRETS_FILE}`);
  return deployEnv(outputs, parseEnv(await Bun.file(SECRETS_FILE).text()));
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

const push = async (outputs: Outputs): Promise<void> => {
  const envFile = renderEnvFile(await loadDeployEnv(outputs));
  const host = `root@${outputs.public_ip}`;
  await $`bun scripts/production.ts --build-only`;
  await $`ssh ${SSH} ${host} cloud-init status --wait`.quiet();
  await $`rsync -az --delete -e ${`ssh ${SSH.join(" ")}`} ${RSYNC_EXCLUDES.map((pattern) => `--exclude=${pattern}`)} ./ ${host}:${outputs.app_dir}/`;
  await $`ssh ${SSH} ${host} install -m 600 -o app /dev/stdin /etc/trusted-trade.env < ${new Response(envFile)}`;
  await $`ssh ${SSH} ${host} install -m 644 /dev/stdin /etc/caddy/Caddyfile < ${new Response(renderCaddyfile(outputs))}`;
  await $`ssh ${SSH} ${host} ${`cd ${outputs.app_dir} && bun install --frozen-lockfile --ignore-scripts && chown -R app:app . && systemctl restart trusted-trade && systemctl reload caddy`}`;
  await waitForHealth(outputs.public_base_url);
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
