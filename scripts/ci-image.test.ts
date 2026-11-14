import { $ } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveConfigDigest, validateImageReport } from "./ci-image.ts";

const os = { Class: "os-pkgs", Type: "debian", Target: "image", Packages: [{ Name: "libc" }] };
const node = {
  Class: "lang-pkgs",
  Type: "node-pkg",
  Target: "Node.js",
  Packages: [
    {
      Name: "example",
      FilePath: "app/node_modules/.bun/example/node_modules/example/package.json",
    },
  ],
};
const report = (results: unknown[]) => JSON.stringify({ Results: results });

describe("image scan report", () => {
  test("requires both installed package inventories", () => {
    expect(validateImageReport(report([os, node]))).toBe(0);
    expect(() => validateImageReport(report([os]))).toThrow();
    expect(() => validateImageReport(report([node]))).toThrow();
    expect(() =>
      validateImageReport(
        report([os, { ...node, Packages: [{ Name: "example", FilePath: "app/bun.lock" }] }]),
      ),
    ).toThrow();
  });
  test("counts unfixed blocking vulnerabilities and retains lower severities", () => {
    expect(
      validateImageReport(
        report([
          os,
          {
            ...node,
            Vulnerabilities: [{ Severity: "LOW" }, { Severity: "HIGH" }, { Severity: "CRITICAL" }],
          },
        ]),
      ),
    ).toBe(2);
  });
  test("fails closed on malformed reports", () => {
    expect(() => validateImageReport("{}")).toThrow();
    expect(() =>
      validateImageReport(report([os, { ...node, Vulnerabilities: [{ Severity: "TYPO" }] }])),
    ).toThrow();
  });
});

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const digest = (text: string) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

const archive = async (
  options: { config?: string; tamper?: boolean; manifests?: number } = {},
): Promise<{ path: string; config: string; manifest: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "ci-image-"));
  dirs.push(dir);
  const root = join(dir, "oci");
  await mkdir(join(root, "blobs", "sha256"), { recursive: true });
  const blob = (text: string) =>
    writeFile(join(root, "blobs", "sha256", digest(text).slice(7)), text);
  const configText = options.config ?? JSON.stringify({ architecture: "amd64", os: "linux" });
  const config = digest(configText);
  await (options.tamper
    ? writeFile(join(root, "blobs", "sha256", config.slice(7)), `${configText} `)
    : blob(configText));
  const manifestText = JSON.stringify({ schemaVersion: 2, config: { digest: config }, layers: [] });
  const manifest = digest(manifestText);
  await blob(manifestText);
  const entry = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifest };
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: Array.from({ length: options.manifests ?? 1 }, () => entry),
    }),
  );
  const path = join(dir, "image.tar");
  await $`tar -cf ${path} -C ${root} index.json blobs`.quiet();
  return { path, config, manifest };
};

const failure = (path: string): Promise<string> =>
  archiveConfigDigest(path).then(
    (config) => `accepted ${config}`,
    (error: unknown) => String(error),
  );

describe("image archive identity", () => {
  test("returns the verified config digest, not the manifest digest", async () => {
    const image = await archive();
    expect(await archiveConfigDigest(image.path)).toBe(image.config);
    expect(image.config).not.toBe(image.manifest);
  });
  test("distinguishes a different image", async () => {
    const first = await archive();
    const second = await archive({
      config: JSON.stringify({ architecture: "arm64", os: "linux" }),
    });
    expect(await archiveConfigDigest(second.path)).not.toBe(first.config);
  });
  test("rejects a config blob that does not match its digest", async () => {
    const image = await archive({ tamper: true });
    expect(await failure(image.path)).toContain("has digest");
  });
  test("rejects an archive without exactly one manifest or without an index", async () => {
    expect(await failure((await archive({ manifests: 2 })).path)).toContain("exactly one manifest");
    expect(await failure(join(tmpdir(), "missing-image.tar"))).toContain("index.json");
  });
});
