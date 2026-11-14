import { describe, expect, test } from "bun:test";
import { versionedViewUri, viewVersion } from "./view-uri.ts";

describe("view URIs", () => {
  test("the version is the first 12 hex characters of the digest", () => {
    expect(viewVersion("0123456789abcdef0123")).toBe("0123456789ab");
  });

  test("the versioned URI appends the version to the base URI", () => {
    expect(versionedViewUri("ui://trusted-trade/approval-card", "0123456789ab")).toBe(
      "ui://trusted-trade/approval-card/0123456789ab",
    );
  });
});
