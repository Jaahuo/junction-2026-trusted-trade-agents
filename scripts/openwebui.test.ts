import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runSetup(override?: string) {
  const root = await mkdtemp(join(tmpdir(), "openwebui-setup-"));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
  });
  try {
    const scripts = join(root, "scripts");
    const host = join(root, "hosts", "openwebui");
    const bin = join(root, "bin");
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(host, { recursive: true }),
      mkdir(bin, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(join(import.meta.dir, "openwebui.ts"), join(scripts, "openwebui.ts")),
      copyFile(join(import.meta.dir, "runtime.ts"), join(scripts, "runtime.ts")),
      writeFile(join(host, ".env"), ""),
      writeFile(join(bin, "docker"), '#!/bin/sh\nprintf "%s" "$FAKE_COMPOSE_CONFIG"\n'),
      writeFile(join(bin, "python3"), '#!/bin/sh\nprintf "unchanged: %s\\n" "$MCP_SERVER_URL"\n'),
      writeFile(join(bin, "git"), '#!/bin/sh\nprintf "%s\\n" "$FAKE_ROOT"\n'),
    ]);
    await Promise.all(["docker", "python3", "git"].map((name) => chmod(join(bin, name), 0o755)));
    const environment = {
      OPENWEBUI_PORT: String(server.port),
      WEBUI_SECRET_KEY: "test-secret",
      WEBUI_ADMIN_EMAIL: "test@example.com",
      WEBUI_ADMIN_PASSWORD: "test-password",
      ...(override ? { OPENWEBUI_MCP_URL: override } : {}),
    };
    const child = Bun.spawn([process.execPath, join(scripts, "openwebui.ts"), "setup"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        CI: "1",
        DATABASE_URL: "test",
        PORT: "43123",
        FAKE_ROOT: root,
        FAKE_COMPOSE_CONFIG: JSON.stringify({
          services: { "open-webui": { environment } },
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test("setup prints the default worktree MCP URL", async () => {
  const result = await runSetup();
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("tool server: http://host.docker.internal:43123/mcp");
  expect(result.stderr).not.toContain("Warning:");
});

test("setup prints the MCP URL when provisioning is unchanged", async () => {
  const result = await runSetup();
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("unchanged: http://host.docker.internal:43123/mcp");
  expect(result.stdout).toContain("tool server: http://host.docker.internal:43123/mcp");
});

test("setup does not warn for an explicit worktree MCP URL", async () => {
  const url = "http://host.docker.internal:43123/mcp";
  const result = await runSetup(url);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(`tool server: ${url}`);
  expect(result.stderr).not.toContain("Warning:");
});

test("setup warns for another worktree MCP URL", async () => {
  const url = "http://host.docker.internal:43124/mcp";
  const result = await runSetup(url);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(`tool server: ${url}`);
  expect(result.stderr).toContain(
    `Warning: OPENWEBUI_MCP_URL overrides this worktree's MCP server: ${url}`,
  );
});

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
