import { describe, expect, test } from "bun:test";
import { needsFullTests } from "./changed-tests.ts";

describe("changed test selection", () => {
  test("leaves ordinary source and test changes to Bun's dependency graph", () => {
    expect(needsFullTests("M\0contexts/notes/src/domain/note.ts\0M\0scripts/new.test.ts\0")).toBe(
      false,
    );
  });

  test("runs all tests for root or workspace configuration changes", () => {
    for (const path of [
      "package.json",
      "contexts/notes/package.json",
      "bun.lock",
      "tsconfig.json",
      "packages/ui/tsconfig.build.json",
      "vite.config.ts",
      "apps/web/vitest.config.mts",
      "bunfig.toml",
    ]) {
      expect(needsFullTests(`M\0${path}\0`)).toBe(true);
      expect(needsFullTests(`?\0${path}\0`)).toBe(true);
    }
  });

  test("runs all tests for shared workspace package changes", () => {
    expect(needsFullTests("M\0packages/kernel/src/index.ts\0")).toBe(true);
  });

  test("runs dynamically read design documentation through the full suite", () => {
    expect(needsFullTests("M\0DESIGN.md\0")).toBe(true);
    expect(needsFullTests("M\0docs/workflow.md\0")).toBe(false);
  });

  test("runs all tests for deletions, including rename sources", () => {
    expect(needsFullTests("D\0src/deleted.ts\0A\0src/renamed.ts\0")).toBe(true);
  });

  test("handles NUL-delimited paths containing newlines", () => {
    expect(needsFullTests("M\0src/odd\nname.ts\0M\0nested/package.json\0")).toBe(true);
    expect(needsFullTests("M\0src/odd\npackage.json.ts\0")).toBe(false);
  });
});
