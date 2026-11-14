import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployEnv,
  type Outputs,
  parseEnv,
  push,
  parseOutputs,
  renderCaddyfile,
  renderEnvFile,
  renderService,
  resetEnv,
  transferData,
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
    await writeFile(join(root, "rsync"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n');
    await chmod(join(root, "ssh"), 0o755);
    await chmod(join(root, "rsync"), 0o755);
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

test("data transfer sends files to the literal remote data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-rsync-"));
  try {
    const source = join(root, "source");
    const appDir = join(root, "app");
    const destination = join(appDir, "data");
    const remoteShell = join(root, "local-remote-shell");
    await mkdir(source);
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "catalog.json"), '{"catalog":"transferred"}\n');
    await writeFile(join(destination, "retained.json"), '{"retained":true}\n');
    // rsync invokes the remote shell with a host followed by a shell command, as ssh does.
    await writeFile(remoteShell, '#!/bin/sh\nshift\nexec /bin/sh -c "$*"\n');
    await chmod(remoteShell, 0o755);

    await transferData(`${source}/`, "local", appDir, remoteShell);

    expect(await readFile(join(destination, "catalog.json"), "utf8")).toBe(
      '{"catalog":"transferred"}\n',
    );
    expect(await readFile(join(destination, "retained.json"), "utf8")).toBe('{"retained":true}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the service runs the persisted digest on loopback with read-only host data", () => {
  const unit = renderService({ ...outputs, app_port: 8123, app_dir: "/opt/trusted trade" });
  expect(unit).toContain("EnvironmentFile=/etc/trusted-trade-image.env\n");
  expect(unit).toContain(
    'ExecStart=/usr/bin/docker run --rm --name trusted-trade --pull=never --env-file /etc/trusted-trade.env -p 127.0.0.1:8123:3000 -v "/opt/trusted trade/data:/app/data:ro" ${TRUSTED_TRADE_IMAGE}\n',
  );
  expect(unit).toContain(
    "ExecStop=/usr/bin/docker stop --time 30 trusted-trade\nTimeoutStopSec=40\n",
  );
  expect(() => renderService({ ...outputs, app_dir: "/opt/a:b" })).toThrow(/app_dir/);
});
