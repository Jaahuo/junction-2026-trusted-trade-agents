import { expect, test } from "bun:test";
import {
  deployEnv,
  type Outputs,
  parseEnv,
  parseOutputs,
  renderCaddyfile,
  renderEnvFile,
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
  expect(file).toContain(`OFFER_SIGNING_JWK='${jwk}'`);
  expect(file).toContain("MCP_VIEW_TOOLS='app'");
  expect(file).toContain("NODE_ENV='production'");
  expect(file).toContain("PUBLIC_BASE_URL='https://203-0-113-7.sslip.io'");
  expect(file).toContain(`DATABASE_URL='${outputs.database_url}'`);
});

test("a hosted setting wins over the same name in the secrets file", async () => {
  const file = renderEnvFile(
    await deployEnv(outputs, parseEnv(`${keys}DATABASE_URL=postgres://local/x\n`)),
  );
  expect(file).not.toContain("postgres://local/x");
  expect(file.match(/^DATABASE_URL=/gm)).toHaveLength(1);
});

test("a missing setting or a quote in a value fails before anything ships", async () => {
  expect(await failure(deployEnv(outputs, parseEnv("OFFER_SIGNING_KID=k1\n")))).toMatch(
    /lacks OFFER_SIGNING_JWK, BUYER_SIGNING_JWK/,
  );
  expect(await failure(deployEnv(outputs, parseEnv(`${keys}OFFER_SIGNING_KID= \n`)))).toMatch(
    /lacks OFFER_SIGNING_KID/,
  );
  const env = await deployEnv(outputs, parseEnv(`${keys}NOTE=it's\n`));
  expect(() => renderEnvFile(env)).toThrow(/NOTE/);
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
