// Runs and provisions the local Open WebUI host.
import { loadRuntime } from "./runtime.ts";

const HOST_DIR = `${import.meta.dir}/../hosts/openwebui`;
const ENV_FILE = `${HOST_DIR}/.env`;
const DEFAULT_MODEL_URL = "https://containers.datacrunch.io/nemotron-3-5-super-vl-b300/v1";
const DEFAULT_MODEL = "nemotron-3.5-super-vl";
const USAGE = "Usage: bun scripts/openwebui.ts up|setup|setup-buyer|down";

const COMPOSE = ["docker", "compose", "--env-file", ENV_FILE, "-f", `${HOST_DIR}/compose.yaml`];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function settings(): Promise<Record<string, string>> {
  const child = Bun.spawn([...COMPOSE, "config", "--format", "json"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error("Could not resolve Open WebUI Compose settings.");
  const config: unknown = JSON.parse(output);
  if (
    !isObject(config) ||
    !isObject(config["services"]) ||
    !isObject(config["services"]["open-webui"]) ||
    !isObject(config["services"]["open-webui"]["environment"])
  )
    throw new Error("Compose returned no Open WebUI environment.");
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(config["services"]["open-webui"]["environment"])) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

export interface ChatHost {
  readonly base: string;
  readonly email: string;
  readonly password: string;
  readonly mcpUrl: string;
  readonly openaiUrl?: string | undefined;
  readonly openaiKey?: string | undefined;
  readonly baseModel?: string | undefined;
  readonly maxTokens?: string | undefined;
  readonly recipePermission?: string | undefined;
  readonly mcpKey?: string | undefined;
}

/** Map the public host interface to the Python provisioner's environment. */
export function provisionEnv(host: ChatHost): Record<string, string> {
  return {
    WEBUI_BASE_URL: host.base,
    COMPANION_FILES: HOST_DIR,
    WEBUI_ADMIN_EMAIL: host.email,
    WEBUI_ADMIN_PASSWORD: host.password,
    MCP_SERVER_URL: host.mcpUrl,
    OPENAI_API_BASE_URL: host.openaiUrl || DEFAULT_MODEL_URL,
    OPENAI_API_KEY: host.openaiKey ?? "",
    AGENT_MODEL_ID: host.baseModel || DEFAULT_MODEL,
    OPENWEBUI_MAX_TOKENS: host.maxTokens || "4096",
    VALIO_AIMO_RECIPE_PERMISSION: host.recipePermission || "False",
    MCP_AGENT_KEY: host.mcpKey || "",
  };
}

export function localHost(env: Record<string, string>, mcpUrl: string): ChatHost {
  return {
    base: `http://127.0.0.1:${env["OPENWEBUI_PORT"] || "38090"}`,
    email: env["WEBUI_ADMIN_EMAIL"] || "",
    password: env["WEBUI_ADMIN_PASSWORD"] || "",
    mcpUrl,
    openaiUrl: env["OPENAI_API_BASE_URL"],
    openaiKey: env["OPENAI_API_KEY"],
    baseModel: env["OPENWEBUI_BASE_MODEL"],
    maxTokens: env["OPENWEBUI_MAX_TOKENS"],
    recipePermission: env["VALIO_AIMO_RECIPE_PERMISSION"],
    mcpKey: env["MCP_AGENT_KEY"],
  };
}

export async function configure(host: ChatHost): Promise<void> {
  console.log(`tool server: ${host.mcpUrl}`);
  const child = Bun.spawn(["python3", `${HOST_DIR}/scripts/provision_agent.py`], {
    env: { ...process.env, ...provisionEnv(host) },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) throw new Error(`Open WebUI provisioning failed (exit ${status}).`);
}

export async function waitUntilUp(base: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const up = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (up) return;
    await Bun.sleep(2000);
  }
  throw new Error(`Open WebUI did not answer at ${base} within 3 minutes.`);
}

async function compose(...args: string[]): Promise<void> {
  const child = Bun.spawn([...COMPOSE, ...args], { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`docker compose ${args.join(" ")} failed.`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "up" && command !== "setup" && command !== "setup-buyer" && command !== "down")
    throw new Error(USAGE);
  const file = Bun.file(ENV_FILE);
  if (!(await file.exists()))
    throw new Error(
      "Missing hosts/openwebui/.env. Copy hosts/openwebui/.env.example and fill it in.",
    );
  const env = await settings();
  if (command === "down") return compose("down");
  if (!env["WEBUI_SECRET_KEY"])
    throw new Error("Set WEBUI_SECRET_KEY in hosts/openwebui/.env (openssl rand -hex 32).");
  if (!env["WEBUI_ADMIN_EMAIL"] || !env["WEBUI_ADMIN_PASSWORD"])
    throw new Error("Set WEBUI_ADMIN_EMAIL and WEBUI_ADMIN_PASSWORD in hosts/openwebui/.env.");
  let mcpUrl = env["OPENWEBUI_MCP_URL"];
  if (mcpUrl)
    console.error(`Warning: OPENWEBUI_MCP_URL overrides this worktree's MCP server: ${mcpUrl}`);
  else {
    await loadRuntime();
    mcpUrl = `http://host.docker.internal:${process.env["PORT"]}/mcp`;
  }
  const host = localHost(env, mcpUrl);
  if (command === "up") {
    await compose("stop", "open-webui");
    await compose(
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "python",
      "open-webui",
      "/opt/companion/migrate_auth.py",
    );
    await compose("up", "-d");
  }
  await waitUntilUp(host.base);
  if (command === "setup-buyer") {
    const child = Bun.spawn(["python3", `${HOST_DIR}/scripts/provision_buyer.py`], {
      env: { ...process.env, ...provisionEnv(host) },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) throw new Error("Buyer provisioning failed.");
  } else await configure(host);
  console.log(`Open WebUI is ready at ${host.base}. Choose Acme Kitchens or Acme Bakery.`);
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
