// Runs Open WebUI as a local chat host and sets it up for the buyer agent.
// Usage: bun scripts/openwebui.ts up|setup|down
// Settings and secrets come from the ignored hosts/openwebui/.env; see hosts/openwebui/.env.example.
import { loadRuntime } from "./runtime.ts";

const ROOT = `${import.meta.dir}/..`;
const HOST_DIR = `${ROOT}/hosts/openwebui`;
const SERVER_ID = "trusted-trade";
const MODEL_ID = "buyer-agent";
const USAGE = "Usage: bun scripts/openwebui.ts up|setup|down";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `KEY=value` lines; blank lines and `#` comments are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2].trim();
  }
  return values;
}

/** The first fenced `text` block of docs/buyer-agent-prompt.md: the one copy of the prompt. */
export function extractPrompt(markdown: string): string {
  const match = /^```text\n([\s\S]*?)\n```$/m.exec(markdown);
  const prompt = match?.[1]?.trim();
  if (!prompt) throw new Error("docs/buyer-agent-prompt.md has no ```text prompt block.");
  return prompt;
}

/** The skill is the agent's reference; the prompt comes last, where a small model weighs it most. */
export const buildSystemPrompt = (skill: string, prompt: string): string =>
  `${skill.trim()}\n\n${prompt.trim()}\n`;

export const toolServer = (url: string): Json => ({
  url,
  path: "",
  type: "mcp",
  auth_type: "none",
  key: "",
  config: { enable: true },
  info: { id: SERVER_ID, name: "Trusted trade", description: "Wholesaler MCP server" },
});

const serverId = (connection: unknown): unknown =>
  isObject(connection) && isObject(connection["info"]) ? connection["info"]["id"] : undefined;

/** True when our connection already points at `url`; the server adds fields of its own, so compare ours only. */
export const hasConnection = (existing: readonly unknown[], url: string): boolean =>
  existing.some(
    (connection) =>
      isObject(connection) &&
      serverId(connection) === SERVER_ID &&
      connection["url"] === url &&
      connection["type"] === "mcp",
  );

/** Replaces our connection and keeps every connection that a person added. */
export const mergeConnections = (existing: readonly unknown[], ours: Json): unknown[] => [
  ...existing.filter((connection) => serverId(connection) !== SERVER_ID),
  ours,
];

/** Open WebUI keeps the model endpoint in its database after the first start, so .env must be pushed. */
export const openaiConfig = (url: string, key: string): Json => ({
  ENABLE_OPENAI_API: true,
  OPENAI_API_BASE_URLS: [url],
  OPENAI_API_KEYS: [key],
  OPENAI_API_CONFIGS: {},
});

/** True when the stored endpoint is exactly the one from .env. */
export const hasOpenaiConfig = (current: unknown, url: string, key: string): boolean =>
  isObject(current) &&
  current["ENABLE_OPENAI_API"] === true &&
  JSON.stringify(current["OPENAI_API_BASE_URLS"]) === JSON.stringify([url]) &&
  JSON.stringify(current["OPENAI_API_KEYS"]) === JSON.stringify([key]);

export const modelPayload = (baseModel: string, system: string): Json => ({
  id: MODEL_ID,
  name: "Buyer agent",
  base_model_id: baseModel,
  params: { system, function_calling: "native" },
  meta: {
    description: "Orders from the wholesaler through the trusted-trade tools.",
    capabilities: { vision: false },
    toolIds: [`server:mcp:${SERVER_ID}`],
  },
  access_grants: [],
  is_active: true,
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function settings(): Promise<Record<string, string>> {
  const file = Bun.file(`${HOST_DIR}/.env`);
  if (!(await file.exists()))
    fail("Missing hosts/openwebui/.env. Copy hosts/openwebui/.env.example and fill it in.");
  const values = parseEnv(await file.text());
  if (!values["WEBUI_SECRET_KEY"])
    fail("Set WEBUI_SECRET_KEY in hosts/openwebui/.env (openssl rand -hex 32).");
  return values;
}

async function compose(...args: string[]): Promise<void> {
  const child = Bun.spawn(["docker", "compose", "-f", `${HOST_DIR}/compose.yaml`, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) fail(`docker compose ${args.join(" ")} failed.`);
}

async function waitUntilUp(base: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const up = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (up) return;
    await Bun.sleep(2000);
  }
  fail(`Open WebUI did not answer at ${base} within 3 minutes.`);
}

async function setup(env: Record<string, string>, base: string): Promise<void> {
  let token = "";
  async function call(path: string, body?: Json): Promise<{ status: number; data: unknown }> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = await response.json().catch(() => null);
    return { status: response.status, data };
  }
  async function must(step: string, path: string, body?: Json): Promise<unknown> {
    const { status, data } = await call(path, body);
    if (status !== 200) fail(`${step}: HTTP ${status} from ${path}`);
    return data;
  }

  // With login off, Open WebUI signs every visitor in as its one local account.
  const session = await must("sign in", "/api/v1/auths/signin", { email: "", password: "" });
  if (!isObject(session) || typeof session["token"] !== "string")
    fail(
      "sign in: no token. This setup needs WEBUI_AUTH=False, as hosts/openwebui/compose.yaml sets.",
    );
  token = session["token"];

  let mcpUrl = env["OPENWEBUI_MCP_URL"];
  if (!mcpUrl) {
    await loadRuntime();
    mcpUrl = `http://host.docker.internal:${process.env["PORT"]}/mcp`;
  }
  const current = await must("read tool servers", "/api/v1/configs/tool_servers");
  const existing =
    isObject(current) && Array.isArray(current["TOOL_SERVER_CONNECTIONS"])
      ? current["TOOL_SERVER_CONNECTIONS"]
      : [];
  if (hasConnection(existing, mcpUrl)) console.log("tool server: unchanged");
  else {
    await must("set tool server", "/api/v1/configs/tool_servers", {
      TOOL_SERVER_CONNECTIONS: mergeConnections(existing, toolServer(mcpUrl)),
    });
    console.log(`tool server: ${mcpUrl}`);
  }

  const openaiUrl = env["OPENAI_API_BASE_URL"];
  if (openaiUrl) {
    const openaiKey = env["OPENAI_API_KEY"] ?? "";
    const stored = await must("read model endpoint", "/openai/config");
    if (hasOpenaiConfig(stored, openaiUrl, openaiKey)) console.log("model endpoint: unchanged");
    else {
      await must("set model endpoint", "/openai/config/update", openaiConfig(openaiUrl, openaiKey));
      console.log(`model endpoint: ${openaiUrl}`);
    }
  }

  let baseModel = env["OPENWEBUI_BASE_MODEL"];
  if (!baseModel) {
    const models = await must("list models", "/api/models");
    const ids = (isObject(models) && Array.isArray(models["data"]) ? models["data"] : [])
      .map((model) => (isObject(model) ? model["id"] : undefined))
      .filter((id): id is string => typeof id === "string");
    baseModel = ids.find((id) => id !== MODEL_ID && !/embed/i.test(id));
    if (!baseModel)
      fail("No chat model found. Check OPENAI_API_BASE_URL or set OPENWEBUI_BASE_MODEL.");
  }

  const system = buildSystemPrompt(
    await Bun.file(`${ROOT}/skills/trusted-trade-ordering/SKILL.md`).text(),
    extractPrompt(await Bun.file(`${ROOT}/docs/buyer-agent-prompt.md`).text()),
  );
  const payload = modelPayload(baseModel, system);
  const found = await call(`/api/v1/models/model?id=${MODEL_ID}`);
  if (found.status !== 200 || !isObject(found.data)) {
    await must("create model", "/api/v1/models/create", payload);
    console.log(`model: created ${MODEL_ID} on ${baseModel}`);
  } else {
    const params = isObject(found.data["params"]) ? found.data["params"] : {};
    const same = found.data["base_model_id"] === baseModel && params["system"] === system;
    if (same) console.log("model: unchanged");
    else {
      await must("update model", `/api/v1/models/model/update?id=${MODEL_ID}`, payload);
      console.log(`model: updated ${MODEL_ID} on ${baseModel}`);
    }
  }
  console.log(`Open WebUI is ready at ${base}. Choose the model "Buyer agent".`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "up" && command !== "setup" && command !== "down") fail(USAGE);
  const env = await settings();
  if (command === "down") return compose("down");
  const base = `http://127.0.0.1:${env["OPENWEBUI_PORT"] || "38090"}`;
  if (command === "up") await compose("up", "-d");
  await waitUntilUp(base);
  await setup(env, base);
}

if (import.meta.main) await main();
