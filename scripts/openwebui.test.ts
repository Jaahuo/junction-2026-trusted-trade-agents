import { expect, test } from "bun:test";

test("the buyer workspace preserves recipe and provisioning boundaries", () => {
  const result = Bun.spawnSync(
    ["python3", "-m", "unittest", "discover", "-s", "hosts/openwebui/tests", "-v"],
    {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
