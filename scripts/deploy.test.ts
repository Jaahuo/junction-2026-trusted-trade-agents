import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_SERVICE,
  chatEnv,
  chatSettings,
  deployEnv,
  deployWarning,
  type Outputs,
  parseEnv,
  push,
  parseOutputs,
  renderCaddyfile,
  renderEnvFile,
  renderService,
  resetEnv,
} from "./deploy.ts";

const outputs: Outputs = {
  public_ip: "203.0.113.7",
  hostname: "203-0-113-7.sslip.io",
  public_base_url: "https://203-0-113-7.sslip.io",
  app_dir: "/opt/trusted-trade",
  app_port: 3000,
  database_url: "postgres://u:p%40ss@db.example:5432/tsdb?sslmode=require",
};

const privateJwk = async (): Promise<JsonWebKey> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), alg: "ES256" };
};

const offerKey = await privateJwk();
const buyerKey = await privateJwk();
const jwk = JSON.stringify(offerKey);
const offer = `OFFER_SIGNING_JWK=${jwk}\nOFFER_SIGNING_KID=k1\n`;
const keys = `${offer}BUYER_SIGNING_JWK=${JSON.stringify(buyerKey)}\n`;

const failure = async (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => "no error",
    (error: unknown) => String(error),
  );

test("the env file keeps a JSON key literal and adds the hosted settings", async () => {
  const file = renderEnvFile(
    await deployEnv(outputs, parseEnv(`# keys\n${keys}MCP_VIEW_TOOLS="app"\n`)),
  );
  const entries = new Map(
    file
      .trimEnd()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  expect(entries.get("OFFER_SIGNING_JWK")).toBe(jwk);
  expect(entries.get("MCP_VIEW_TOOLS")).toBe("app");
  expect(entries.get("NODE_ENV")).toBe("production");
  expect(entries.get("PUBLIC_BASE_URL")).toBe(outputs.public_base_url);
  expect(entries.get("DATABASE_URL")).toBe(outputs.database_url);
  expect(entries.get("APP_ROOT")).toBe("/app");
  expect(entries.get("PORT")).toBe("3000");
});

test("a hosted setting wins over the same name in the secrets file", async () => {
  const file = renderEnvFile(
    await deployEnv(outputs, parseEnv(`${keys}DATABASE_URL=postgres://local/x\n`)),
  );
  expect(file).not.toContain("postgres://local/x");
  expect(file.match(/^DATABASE_URL=/gm)).toHaveLength(1);
});

test("a missing setting or a newline in a value fails before anything ships", async () => {
  expect(await failure(deployEnv(outputs, parseEnv("OFFER_SIGNING_KID=k1\n")))).toMatch(
    /lacks OFFER_SIGNING_JWK, BUYER_SIGNING_JWK/,
  );
  expect(await failure(deployEnv(outputs, parseEnv(`${keys}OFFER_SIGNING_KID= \n`)))).toMatch(
    /lacks OFFER_SIGNING_KID/,
  );
  expect(renderEnvFile(new Map([["NOTE", "it's"]]))).toBe("NOTE=it's\n");
  expect(() => renderEnvFile(new Map([["NOTE", "first\nsecond"]]))).toThrow(/NOTE/);
  expect(() => renderEnvFile(new Map([["NOTE", "first\rsecond"]]))).toThrow(/NOTE/);
  expect(() => parseEnv("not a pair")).toThrow(/KEY=VALUE/);
});

test("an empty, public-only, malformed, truncated or mismatched signing key fails before push or reset", async () => {
  const { d, ...publicKey } = buyerKey;
  const other = await privateJwk();
  const cases = [
    "",
    JSON.stringify(publicKey),
    "{not json",
    JSON.stringify({ ...buyerKey, d: (d ?? "").slice(0, 10) }),
    JSON.stringify({ ...buyerKey, d: other.d }),
  ];
  for (const value of cases)
    expect(
      await failure(deployEnv(outputs, parseEnv(`${offer}BUYER_SIGNING_JWK=${value}\n`))),
    ).toMatch(
      value === "" ? /lacks BUYER_SIGNING_JWK/ : /BUYER_SIGNING_JWK must be a private P-256 JWK/,
    );
});

test("outputs parse from tofu output -json, as CI receives them in DEPLOY_OUTPUTS", () => {
  const entries = Object.entries(outputs).map(([name, value]) => [
    name,
    { sensitive: false, value },
  ]);
  expect(parseOutputs(JSON.stringify(Object.fromEntries(entries)))).toEqual(outputs);
  const withoutUrl = entries.filter(([name]) => name !== "database_url");
  expect(() => parseOutputs(JSON.stringify(Object.fromEntries(withoutUrl)))).toThrow(
    /database_url is missing/,
  );
  expect(() => parseOutputs("{}")).toThrow(/public_ip is missing/);
});

test("Caddy serves the hostname with automatic TLS and proxies to the app port", () => {
  expect(renderCaddyfile(outputs)).toBe(
    "203-0-113-7.sslip.io {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:3000\n}\n",
  );
});

const chatSecrets = {
  VERDA_INFERENCE_KEY: "inference-key",
  OPENWEBUI_SECRET_KEY: "session-key",
  OPENWEBUI_ADMIN_EMAIL: "admin@example.com",
  OPENWEBUI_ADMIN_PASSWORD: "admin-password",
};

test("the deploy skips the chat host until the inference key is set", () => {
  expect(chatSettings({})).toBeUndefined();
  expect(chatSettings({ ...chatSecrets, VERDA_INFERENCE_KEY: " " })).toBeUndefined();
  expect(chatSettings({ ...chatSecrets, OPENWEBUI_ADMIN_PASSWORD: "admin-password\r " })).toEqual(
    chatSettings(chatSecrets),
  );
  expect(chatSettings(chatSecrets)).toEqual({
    inferenceKey: "inference-key",
    secretKey: "session-key",
    adminEmail: "admin@example.com",
    adminPassword: "admin-password",
    recipePermission: "False",
  });
});

test("an inference key without the admin login fails before anything is deployed", () => {
  const { OPENWEBUI_ADMIN_PASSWORD: _password, ...partial } = chatSecrets;
  expect(() => chatSettings(partial)).toThrow(/needs OPENWEBUI_ADMIN_PASSWORD/);
});

test("the chat host runs with login on, sign-up off and the hosted inference endpoint", () => {
  const chat = chatSettings(chatSecrets);
  if (!chat) throw new Error("chat settings expected");
  const env = chatEnv(outputs, chat);
  expect(env.get("WEBUI_AUTH")).toBe("True");
  expect(env.get("ENABLE_SIGNUP")).toBe("False");
  expect(env.get("ENABLE_OLLAMA_API")).toBe("False");
  expect(env.get("ENABLE_TITLE_GENERATION")).toBe("False");
  expect(env.get("ENABLE_FOLLOW_UP_GENERATION")).toBe("False");
  expect(env.get("ENABLE_TAGS_GENERATION")).toBe("False");
  expect(env.has("ENABLE_VOICE")).toBe(false);
  expect(env.get("WEBUI_URL")).toBe("https://chat.203-0-113-7.sslip.io");
  expect(env.get("OPENAI_API_BASE_URL")).toBe(
    "https://containers.datacrunch.io/nemotron-3-5-super-vl-b300/v1",
  );
  expect(env.get("OPENAI_API_KEY")).toBe("inference-key");
  expect(env.get("MCP_SERVER_URL")).toBe(`${outputs.public_base_url}/mcp`);
  expect(env.get("AGENT_MODEL_ID")).toBe("nemotron-3.5-super-vl");
  expect(env.get("OPENWEBUI_MAX_TOKENS")).toBe("16384");
  expect(renderEnvFile(env)).toContain("WEBUI_ADMIN_PASSWORD=admin-password\n");
});

test("Caddy serves the chat host on its own subdomain when the chat runs", () => {
  expect(renderCaddyfile(outputs, true)).toBe(
    "203-0-113-7.sslip.io {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:3000\n}\n\n" +
      "chat.203-0-113-7.sslip.io {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:8080\n}\n",
  );
});

test("the chat unit keeps its data in a volume and listens on loopback only", () => {
  expect(CHAT_SERVICE).toContain("-p 127.0.0.1:8080:8080");
  expect(CHAT_SERVICE).toContain("-v trusted-trade-chat:/app/backend/data");
  expect(CHAT_SERVICE).not.toContain("/opt/trusted-trade-chat/branding");
  expect(CHAT_SERVICE).toContain("--env-file /etc/trusted-trade-chat.env");
  expect(CHAT_SERVICE).toContain("ConditionPathExists=/etc/trusted-trade-chat-image.env");
  expect(CHAT_SERVICE).toContain("EnvironmentFile=/etc/trusted-trade-chat-image.env");
  expect(CHAT_SERVICE).toContain("${TRUSTED_TRADE_CHAT_IMAGE}");
});

test("a reset runs with the hosted keys and production mode against the local checkout", async () => {
  const env = resetEnv(
    await deployEnv(outputs, parseEnv(keys)),
    { BUYER_SIGNING_JWK: "local-key", NODE_ENV: "development", PATH: "/usr/bin" },
    "/work/checkout",
  );
  expect(env["BUYER_SIGNING_JWK"]).toBe(JSON.stringify(buyerKey));
  expect(env["NODE_ENV"]).toBe("production");
  expect(env["DATABASE_URL"]).toBe(outputs.database_url);
  expect(env["APP_ROOT"]).toBe("/work/checkout");
  expect(env["PATH"]).toBe("/usr/bin");
});

test("push rejects untrusted image references before loading secrets or touching the host", async () => {
  const repo = "ghcr.io/jaahuo/junction-2026-trusted-trade-agents";
  for (const image of [
    "",
    `${repo}:latest`,
    `${repo}:${"a".repeat(40)}`,
    `${repo}@sha256:${"A".repeat(64)}`,
    `${repo}@sha256:${"a".repeat(63)}`,
    `ghcr.io/other/image@sha256:${"a".repeat(64)}`,
    `${repo}@sha256:${"a".repeat(64)};touch /tmp/injected`,
  ]) {
    expect(await failure(push(outputs, { DEPLOY_IMAGE: image }))).toMatch(/DEPLOY_IMAGE/);
  }
  expect(
    await failure(push(outputs, { DEPLOY_IMAGE: `${repo}@sha256:${"a".repeat(64)}` })),
  ).toMatch(/DEPLOY_REGISTRY_USER/);
});

test("chat requires a trusted immutable image only when enabled", async () => {
  const repo = "ghcr.io/jaahuo/junction-2026-trusted-trade-agents";
  const image = `${repo}@sha256:${"a".repeat(64)}`;
  for (const chatImage of [
    "",
    `${repo}:latest`,
    `${repo}@sha256:${"A".repeat(64)}`,
    `ghcr.io/other/image@sha256:${"b".repeat(64)}`,
  ]) {
    expect(
      await failure(
        push(outputs, { ...chatSecrets, DEPLOY_IMAGE: image, DEPLOY_CHAT_IMAGE: chatImage }),
      ),
    ).toMatch(/DEPLOY_CHAT_IMAGE/);
  }
});

test("push uses the exact digest and strict host checking, and stops on a digest mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-push-"));
  const previous = { ...process.env };
  const image = `ghcr.io/jaahuo/junction-2026-trusted-trade-agents@sha256:${"a".repeat(64)}`;
  const imageId = `sha256:${"c".repeat(64)}`;
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  try {
    const log = join(root, "commands");
    const input = join(root, "input");
    await writeFile(
      join(root, "ssh"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\ncase "$*" in\n  *"docker container inspect"*) printf "%s %s\\n" "$FAKE_CONTAINER_IMAGE" "$FAKE_CONTAINER_RUNNING";;\n  *"docker image inspect"*) printf "%s\\n%s\\n" "$FAKE_IMAGE_ID" "$FAKE_DIGEST";;\n  *"install -m"*) cat >> "$FAKE_INPUT";;\nesac\n',
    );
    await chmod(join(root, "ssh"), 0o755);
    process.env["PATH"] = `${root}:${previous["PATH"] ?? ""}`;
    process.env["DEPLOY_ENV"] = keys;
    process.env["FAKE_LOG"] = log;
    process.env["FAKE_INPUT"] = input;
    process.env["FAKE_DIGEST"] = image;
    process.env["FAKE_IMAGE_ID"] = imageId;
    process.env["FAKE_CONTAINER_IMAGE"] = imageId;
    process.env["FAKE_CONTAINER_RUNNING"] = "true";
    const settings = {
      DEPLOY_IMAGE: image,
      DEPLOY_REGISTRY_USER: "user",
      DEPLOY_REGISTRY_TOKEN: "token",
    };
    const localOutputs = { ...outputs, public_base_url: `http://127.0.0.1:${server.port}` };
    await push(localOutputs, settings);
    const commands = await readFile(log, "utf8");
    expect(commands).toContain(`docker pull '${image}'`);
    expect(commands).toContain("StrictHostKeyChecking=yes");
    expect(commands).not.toContain("StrictHostKeyChecking=accept-new");
    expect(await readFile(input, "utf8")).toContain(`TRUSTED_TRADE_IMAGE="${image}"`);
    expect(commands).not.toMatch(/rsync|mkdir -p.*\/data|chown.*\/data|chmod.*\/data/);
    expect(await readFile(input, "utf8")).not.toContain("/app/data");

    process.env["FAKE_CONTAINER_IMAGE"] = `sha256:${"d".repeat(64)}`;
    expect(await failure(push(localOutputs, settings))).toMatch(/Running container image hash/);
    process.env["FAKE_CONTAINER_IMAGE"] = imageId;
    process.env["FAKE_CONTAINER_RUNNING"] = "false";
    expect(await failure(push(localOutputs, settings))).toMatch(/running state/);
    process.env["FAKE_CONTAINER_RUNNING"] = "true";

    await writeFile(log, "");
    process.env["FAKE_IMAGE_ID"] = "invalid";
    expect(await failure(push(localOutputs, settings))).toMatch(/invalid SHA-256 image ID/);
    expect(await readFile(log, "utf8")).not.toContain("systemctl stop trusted-trade");
    process.env["FAKE_IMAGE_ID"] = imageId;
    await writeFile(log, "");
    process.env["FAKE_DIGEST"] =
      `ghcr.io/jaahuo/junction-2026-trusted-trade-agents@sha256:${"b".repeat(64)}`;
    expect(await failure(push(localOutputs, settings))).toMatch(/requested repository digest/);
    expect(await readFile(log, "utf8")).not.toContain("systemctl stop trusted-trade");
  } finally {
    await server.stop();
    for (const name of [
      "PATH",
      "DEPLOY_ENV",
      "FAKE_LOG",
      "FAKE_INPUT",
      "FAKE_DIGEST",
      "FAKE_IMAGE_ID",
      "FAKE_CONTAINER_IMAGE",
      "FAKE_CONTAINER_RUNNING",
    ]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("chat digest is verified before disruption and provisioning failure stops deployment", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-chat-"));
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  const repo = "ghcr.io/jaahuo/junction-2026-trusted-trade-agents";
  const image = `${repo}@sha256:${"a".repeat(64)}`;
  const chatImage = `${repo}@sha256:${"b".repeat(64)}`;
  const appId = `sha256:${"c".repeat(64)}`;
  const chatId = `sha256:${"d".repeat(64)}`;
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  try {
    const log = join(root, "commands");
    const input = join(root, "input");
    await writeFile(
      join(root, "ssh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *"io.trusted-trade.service"*) printf '%s\\n' "$FAKE_CHAT_ROLE";;
  *"docker container inspect"*"trusted-trade-chat"*) printf '%s true\\n' "$FAKE_CHAT_RUNNING";;
  *"docker container inspect"*) printf '%s true\\n' "$FAKE_APP_ID";;
  *"docker image inspect"*"${chatImage}"*) printf '%s\\n%s\\n' "$FAKE_CHAT_ID" "$FAKE_CHAT_DIGEST";;
  *"docker image inspect"*) printf '%s\\n%s\\n' "$FAKE_APP_ID" "$FAKE_APP_DIGEST";;
  *"docker exec trusted-trade-chat"*) [ "$FAKE_PROVISION_FAIL" != 1 ];;
  *"install -m"*) cat >> "$FAKE_INPUT";;
esac
`,
    );
    await chmod(join(root, "ssh"), 0o755);
    process.env["PATH"] = `${root}:${previous["PATH"] ?? ""}`;
    process.env["DEPLOY_ENV"] = keys;
    process.env["FAKE_LOG"] = log;
    process.env["FAKE_INPUT"] = input;
    process.env["FAKE_APP_ID"] = appId;
    process.env["FAKE_APP_DIGEST"] = image;
    process.env["FAKE_CHAT_ID"] = chatId;
    process.env["FAKE_CHAT_DIGEST"] = image;
    process.env["FAKE_PROVISION_FAIL"] = "0";
    process.env["FAKE_CHAT_RUNNING"] = chatId;
    process.env["FAKE_CHAT_ROLE"] = "api";
    globalThis.fetch = Object.assign(
      (request: RequestInfo | URL, init?: RequestInit) => {
        const url = request instanceof Request ? request.url : request.toString();
        return url.startsWith("https://chat.")
          ? Promise.resolve(new Response("ok"))
          : previousFetch(request, init);
      },
      { preconnect: previousFetch.preconnect },
    );
    const settings = {
      ...chatSecrets,
      DEPLOY_IMAGE: image,
      DEPLOY_CHAT_IMAGE: chatImage,
      DEPLOY_REGISTRY_USER: "user",
      DEPLOY_REGISTRY_TOKEN: "token",
    };
    const localOutputs = { ...outputs, public_base_url: `http://127.0.0.1:${server.port}` };
    expect(await failure(push(localOutputs, settings))).toMatch(/requested repository digest/);
    expect(await readFile(log, "utf8")).not.toContain("systemctl stop trusted-trade");

    process.env["FAKE_CHAT_ID"] = "invalid";
    await writeFile(log, "");
    expect(await failure(push(localOutputs, settings))).toMatch(/invalid SHA-256 image ID/);
    expect(await readFile(log, "utf8")).not.toContain("systemctl stop trusted-trade");
    process.env["FAKE_CHAT_ID"] = chatId;

    process.env["FAKE_CHAT_DIGEST"] = chatImage;
    await writeFile(log, "");
    expect(await failure(push(localOutputs, settings))).toMatch(/not an Open WebUI image/);
    expect(await readFile(log, "utf8")).not.toContain("install -m");
    expect(await readFile(log, "utf8")).not.toContain("systemctl stop trusted-trade");
    process.env["FAKE_CHAT_ROLE"] = "openwebui";
    process.env["FAKE_CHAT_RUNNING"] = appId;
    await writeFile(log, "");
    expect(await failure(push(localOutputs, settings))).toMatch(
      /Running chat container image hash/,
    );
    expect(await readFile(log, "utf8")).not.toContain("docker exec trusted-trade-chat");
    expect(await readFile(input, "utf8")).toContain(`TRUSTED_TRADE_CHAT_IMAGE="${chatImage}"`);
    const installed = await readFile(input, "utf8");
    expect(installed).toContain(`WEBUI_ADMIN_EMAIL=${chatSecrets.OPENWEBUI_ADMIN_EMAIL}`);
    expect(installed).toContain(`WEBUI_ADMIN_PASSWORD=${chatSecrets.OPENWEBUI_ADMIN_PASSWORD}`);
    expect(installed).toContain(`OPENAI_API_KEY=${chatSecrets.VERDA_INFERENCE_KEY}`);
    expect(installed).toContain(`MCP_SERVER_URL=${localOutputs.public_base_url}/mcp`);

    process.env["FAKE_CHAT_RUNNING"] = chatId;
    await writeFile(log, "");
    await push(localOutputs, settings);
    const successfulCommands = await readFile(log, "utf8");
    expect(successfulCommands).toContain(
      "docker exec trusted-trade-chat python /opt/trusted-trade/hosts/openwebui/scripts/provision_agent.py",
    );
    expect(successfulCommands).not.toMatch(/rsync[^\n]*hosts\/openwebui/);
    expect(successfulCommands).not.toContain("python3");
    process.env["FAKE_PROVISION_FAIL"] = "1";
    await writeFile(log, "");
    expect(await failure(push(localOutputs, settings))).not.toBe("no error");
    const commands = await readFile(log, "utf8");
    expect(commands).toContain(
      "docker exec trusted-trade-chat python /opt/trusted-trade/hosts/openwebui/scripts/provision_agent.py",
    );
    expect(commands.indexOf("systemctl restart trusted-trade-chat")).toBeGreaterThan(
      commands.indexOf(
        "docker container inspect --format '{{.Image}} {{.State.Running}}' trusted-trade",
      ),
    );
  } finally {
    globalThis.fetch = previousFetch;
    await server.stop();
    for (const name of [
      "PATH",
      "DEPLOY_ENV",
      "FAKE_LOG",
      "FAKE_INPUT",
      "FAKE_APP_ID",
      "FAKE_APP_DIGEST",
      "FAKE_CHAT_ID",
      "FAKE_CHAT_DIGEST",
      "FAKE_CHAT_RUNNING",
      "FAKE_CHAT_ROLE",
      "FAKE_PROVISION_FAIL",
    ]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("the service runs the persisted digest on loopback without a data mount", () => {
  const unit = renderService({ ...outputs, app_port: 8123 });
  expect(unit).toContain("EnvironmentFile=/etc/trusted-trade-image.env\n");
  expect(unit).toContain(
    "ExecStart=/usr/bin/docker run --rm --name trusted-trade --pull=never --env-file /etc/trusted-trade.env -p 127.0.0.1:8123:3000 ${TRUSTED_TRADE_IMAGE}\n",
  );
  expect(unit).not.toMatch(/(?: -v | --mount |\/app\/data)/);
  expect(unit).toContain(
    "ExecStop=/usr/bin/docker stop --time 30 trusted-trade\nTimeoutStopSec=40\n",
  );
});

test("cloud-init provisions the API without catalogue transfer or a data mount", async () => {
  const cloudInit = await Bun.file("infra/cloud-init.yaml.tftpl").text();
  expect(cloudInit).not.toMatch(/rsync|\/app\/data|app_dir\}\/data| --mount | -v /);
  expect(cloudInit).toContain("127.0.0.1:${app_port}:3000 $${TRUSTED_TRADE_IMAGE}");
});

const deployRun = (conclusion: string) => [
  {
    conclusion,
    headSha: "4dd8571c935a769c38b296e033b52130e8d2055f",
    url: "https://example.test/runs/1",
  },
];

test("deployWarning warns only when the latest completed deploy of main failed", () => {
  expect(deployWarning(deployRun("failure"))).toBe(
    "Warning: the latest deploy of main (4dd8571) ended in failure, so the hosted demo may be stale. See https://example.test/runs/1.",
  );
  expect(deployWarning(deployRun("timed_out"))).toContain("timed_out");
  expect(deployWarning(deployRun("startup_failure"))).toContain("startup_failure");
  expect(deployWarning(deployRun("success"))).toBeUndefined();
  expect(deployWarning(deployRun("cancelled"))).toBeUndefined();
  expect(deployWarning([])).toBeUndefined();
  expect(deployWarning({})).toBeUndefined();
  expect(deployWarning([{ conclusion: "failure" }])).toBe(
    "Warning: the latest deploy of main (?) ended in failure, so the hosted demo may be stale. See the deploy workflow.",
  );
});
