import { describe, expect, test } from "bun:test";
import { validateImageReport } from "./ci-image.ts";

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
