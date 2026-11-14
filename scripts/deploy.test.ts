import { expect, test } from "bun:test";
import { type Outputs, parseEnv, renderCaddyfile, renderEnvFile } from "./deploy.ts";

const outputs: Outputs = {
  public_ip: "203.0.113.7",
  hostname: "203-0-113-7.sslip.io",
  public_base_url: "https://203-0-113-7.sslip.io",
  app_dir: "/opt/trusted-trade",
  app_port: 3000,
  database_url: "postgres://u:p%40ss@db.example:5432/tsdb?sslmode=require",
};

const jwk = '{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"c","kid":"k1","alg":"ES256"}';
const keys = `OFFER_SIGNING_JWK=${jwk}\nOFFER_SIGNING_KID=k1\nBUYER_SIGNING_JWK=${jwk}\n`;

test("the env file keeps a JSON key literal and adds the hosted settings", () => {
  const file = renderEnvFile(outputs, parseEnv(`# keys\n${keys}MCP_VIEW_TOOLS="app"\n`));
  expect(file).toContain(`OFFER_SIGNING_JWK='${jwk}'`);
  expect(file).toContain("MCP_VIEW_TOOLS='app'");
  expect(file).toContain("NODE_ENV='production'");
  expect(file).toContain("PUBLIC_BASE_URL='https://203-0-113-7.sslip.io'");
  expect(file).toContain(`DATABASE_URL='${outputs.database_url}'`);
});

test("a hosted setting wins over the same name in the secrets file", () => {
  const file = renderEnvFile(outputs, parseEnv(`${keys}DATABASE_URL=postgres://local/x\n`));
  expect(file).not.toContain("postgres://local/x");
  expect(file.match(/^DATABASE_URL=/gm)).toHaveLength(1);
});

test("a missing signing key or a quote in a value fails before anything ships", () => {
  expect(() => renderEnvFile(outputs, parseEnv("OFFER_SIGNING_KID=k1\n"))).toThrow(
    /OFFER_SIGNING_JWK, BUYER_SIGNING_JWK/,
  );
  expect(() => renderEnvFile(outputs, parseEnv(`${keys}NOTE=it's\n`))).toThrow(/NOTE/);
  expect(() => parseEnv("not a pair")).toThrow(/KEY=VALUE/);
});

test("Caddy serves the hostname with automatic TLS and proxies to the app port", () => {
  expect(renderCaddyfile(outputs)).toBe(
    "203-0-113-7.sslip.io {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:3000\n}\n",
  );
});
