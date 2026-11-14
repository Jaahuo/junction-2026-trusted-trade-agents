import { describe, expect, test } from "bun:test";
import { validateAudit } from "./ci-audit.ts";

// Bun's native report uses numeric advisory IDs; this ID is a test fixture.
const advisory = {
  id: 1234567,
  url: "https://example.com/advisories/example",
  title: "example",
  severity: "moderate",
};

describe("bun audit report", () => {
  test("accepts clean and nonblocking reports", () => {
    expect(validateAudit("{}", 0)).toBe(0);
    expect(validateAudit(JSON.stringify({ esbuild: [advisory] }), 1)).toBe(0);
    expect(validateAudit(JSON.stringify({ example: [{ ...advisory, id: "GHSA-test" }] }), 1)).toBe(
      0,
    );
  });
  test("counts blocking findings", () => {
    expect(
      validateAudit(
        JSON.stringify({
          a: [
            { ...advisory, severity: "high" },
            { ...advisory, severity: "critical" },
          ],
        }),
        1,
      ),
    ).toBe(2);
  });
  test("rejects malformed reports and tool failures", () => {
    for (const [report, code] of [
      ["", 1],
      ["[]", 0],
      ['{"a":[]}', 1],
      [JSON.stringify({ a: [{ ...advisory, severity: "unknown" }] }), 1],
      ["{}", 1],
      [JSON.stringify({ a: [advisory] }), 0],
      ["{}", 2],
    ] as const) {
      expect(() => validateAudit(report, code)).toThrow();
    }
    expect(() => validateAudit(JSON.stringify({ a: [{ ...advisory, id: 1.5 }] }), 1)).toThrow();
    expect(() => validateAudit(JSON.stringify({ a: [{ ...advisory, id: "" }] }), 1)).toThrow();
  });
});
