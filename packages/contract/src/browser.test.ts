import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("package exports reject server helpers in browser builds", async () => {
  // Keep the entrypoints inside the package so self-reference resolves its public exports.
  const dir = await mkdtemp(join(import.meta.dir, "../.browser-test-"));
  try {
    const serverEntry = join(dir, "server.ts");
    const rootEntry = join(dir, "root.ts");
    await writeFile(serverEntry, 'export { principalOf } from "@app/contract/server";\n');
    await writeFile(rootEntry, 'export { DEMO_ACCOUNT } from "@app/contract";\n');

    const browserRoot = await Bun.build({ entrypoints: [rootEntry], target: "browser" });
    expect(browserRoot.success).toBe(true);

    const server = await Bun.build({ entrypoints: [serverEntry], target: "bun" });
    expect(server.success).toBe(true);

    // The missing browser entry prevents fallback to server helpers.
    let buildError: unknown;
    try {
      await Bun.build({ entrypoints: [serverEntry], target: "browser" });
    } catch (error) {
      buildError = error;
    }
    expect(buildError).toBeInstanceOf(AggregateError);
    const errors: unknown[] = buildError instanceof AggregateError ? buildError.errors : [];
    const messages = errors.map((error) =>
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : "",
    );
    expect(
      messages.some((message) =>
        /(?:could not resolve|cannot resolve|failed to resolve).*@app\/contract\/server/i.test(
          message,
        ),
      ),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
