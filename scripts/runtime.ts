import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

interface Project {
  port: number;
  password: string;
}
interface Runtime {
  root: string;
  project: string;
  name: string;
  url: string;
  port: number;
  webPort: number;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
function pause(ms: number): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
}

async function command(args: string[], env = process.env): Promise<string> {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function paths() {
  const root = await realpath(await command(["git", "rev-parse", "--show-toplevel"]));
  const common = await realpath(
    resolve(root, await command(["git", "rev-parse", "--git-common-dir"])),
  );
  const project = hash(common);
  return {
    root,
    project,
    shared: resolve(common, "hackathon-runtime"),
    name: `wt_${hash(root)}`,
  };
}

export async function hasRuntime(worktree: string): Promise<boolean> {
  const root = await realpath(worktree);
  const common = await realpath(
    resolve(root, await command(["git", "-C", root, "rev-parse", "--git-common-dir"])),
  );
  return (
    (await Bun.file(resolve(root, ".local/runtime.json")).exists()) ||
    (await Bun.file(resolve(common, "hackathon-runtime", `wt_${hash(root)}.json`)).exists())
  );
}

async function readProject(path: string): Promise<Project> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("port" in value) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !("password" in value) ||
    typeof value.password !== "string" ||
    !/^[a-f0-9]{48}$/.test(value.password)
  )
    throw new Error(`Invalid project runtime metadata: ${path}`);
  return { port: value.port, password: value.password };
}

async function readRuntime(path: string): Promise<Runtime> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("root" in value) ||
    typeof value.root !== "string" ||
    !value.root.startsWith("/") ||
    !("project" in value) ||
    typeof value.project !== "string" ||
    !/^[a-f0-9]{16}$/.test(value.project) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !/^wt_[a-f0-9]{16}$/.test(value.name) ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("port" in value) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !("webPort" in value) ||
    typeof value.webPort !== "number" ||
    !Number.isInteger(value.webPort) ||
    value.webPort < 1 ||
    value.webPort > 65535 ||
    value.port === value.webPort
  )
    throw new Error(`Invalid worktree runtime metadata: ${path}`);
  return {
    root: value.root,
    project: value.project,
    name: value.name,
    url: value.url,
    port: value.port,
    webPort: value.webPort,
  };
}

async function available(port: number): Promise<boolean> {
  const { promise, resolve: done } = Promise.withResolvers<boolean>();
  const server = createServer();
  server.once("error", () => done(false));
  server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  return promise;
}

async function freePort(reserved: Set<number>): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = 10000 + Math.floor(Math.random() * 50000);
    if (!reserved.has(port) && (await available(port))) {
      reserved.add(port);
      return port;
    }
  }
  throw new Error("Could not find a free loopback port");
}

async function locked<T>(shared: string, run: () => Promise<T>): Promise<T> {
  await mkdir(shared, { recursive: true, mode: 0o700 });
  const lock = resolve(shared, "lock");
  let acquired = false;
  for (let i = 0; i < 120; i++) {
    try {
      await mkdir(lock);
      acquired = true;
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      await pause(500);
    }
  }
  if (!acquired)
    throw new Error(
      `Runtime setup lock is busy: ${lock}. If no setup is running, remove it manually.`,
    );
  try {
    return await run();
  } finally {
    await rm(lock, { recursive: true });
  }
}

function composeEnv(project: string, config: Project): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: `hackathon_${project}`,
    PG_PORT: String(config.port),
    PG_PASSWORD: config.password,
  };
}

async function compose(root: string, project: string, config: Project, args: string[]) {
  return command(
    ["docker", "compose", "-f", resolve(root, "compose.yaml"), ...args],
    composeEnv(project, config),
  );
}

async function validRuntime(): Promise<Runtime> {
  const p = await paths();
  let runtime: Runtime;
  let config: Project;
  try {
    runtime = await readRuntime(resolve(p.root, ".local/runtime.json"));
    config = await readProject(resolve(p.shared, "project.json"));
    const owned = await readRuntime(resolve(p.shared, `${p.name}.json`));
    if (JSON.stringify(runtime) !== JSON.stringify(owned))
      throw new Error("ownership record mismatch");
  } catch {
    throw new Error(
      "Runtime is not set up or ownership cannot be verified. Run bun scripts/runtime.ts setup.",
    );
  }
  const expected = `postgresql://hackathon:${config.password}@127.0.0.1:${config.port}/${p.name}`;
  if (
    runtime.root !== p.root ||
    runtime.project !== p.project ||
    runtime.name !== p.name ||
    runtime.url !== expected ||
    !Number.isInteger(runtime.port) ||
    !Number.isInteger(runtime.webPort)
  ) {
    throw new Error("Runtime ownership validation failed; refusing to use this database.");
  }
  return runtime;
}

export async function currentDatabase(): Promise<{ url: string; name: string }> {
  const runtime = await validRuntime();
  if (process.env["DATABASE_URL"] && process.env["DATABASE_URL"] !== runtime.url)
    throw new Error("DATABASE_URL differs from the owned worktree database; refusing reset.");
  return { url: runtime.url, name: runtime.name };
}

export async function loadRuntime(): Promise<void> {
  if (process.env["CI"] && process.env["DATABASE_URL"]) {
    process.env["APP_ROOT"] = await realpath(
      await command(["git", "rev-parse", "--show-toplevel"]),
    );
    return;
  }
  const runtime = await validRuntime();
  Object.assign(process.env, {
    APP_ROOT: runtime.root,
    DATABASE_URL: runtime.url,
    PORT: String(runtime.port),
    WEB_PORT: String(runtime.webPort),
  });
}

export async function assertDevPortsAvailable(): Promise<void> {
  const ports = [Number(process.env["PORT"]), Number(process.env["WEB_PORT"])];
  if (
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
    ports[0] === ports[1]
  ) {
    throw new Error("PORT and WEB_PORT must be distinct valid ports.");
  }
  for (const port of ports) {
    if (!(await available(port)))
      throw new Error(
        `Port ${port} is already in use; stop the process using it before starting this worktree.`,
      );
  }
}

export async function setupRuntime(): Promise<void> {
  const p = await paths();
  await locked(p.shared, async () => {
    const reserved = new Set<number>();
    const records = (await readdir(p.shared)).filter((file) =>
      /^wt_[a-f0-9]{16}\.json$/.test(file),
    );
    for (const file of records) {
      const r = await readRuntime(resolve(p.shared, file));
      reserved.add(r.port);
      reserved.add(r.webPort);
    }
    const projectFile = resolve(p.shared, "project.json");
    let config: Project;
    if (await Bun.file(projectFile).exists()) config = await readProject(projectFile);
    else {
      if (records.length > 0)
        throw new Error(
          "Project runtime metadata is missing while worktree ownership records exist; refusing to replace it.",
        );
      config = { port: await freePort(reserved), password: randomBytes(24).toString("hex") };
      await writeFile(projectFile, JSON.stringify(config), { mode: 0o600 });
    }
    reserved.add(config.port);
    const record = resolve(p.shared, `${p.name}.json`);
    let runtime: Runtime;
    if (await Bun.file(record).exists()) {
      runtime = await readRuntime(record);
      if (
        runtime.root !== p.root ||
        runtime.project !== p.project ||
        runtime.name !== p.name ||
        runtime.url !==
          `postgresql://hackathon:${config.password}@127.0.0.1:${config.port}/${p.name}`
      )
        throw new Error("Existing runtime ownership record is invalid");
    } else {
      runtime = {
        root: p.root,
        project: p.project,
        name: p.name,
        url: `postgresql://hackathon:${config.password}@127.0.0.1:${config.port}/${p.name}`,
        port: await freePort(reserved),
        webPort: await freePort(reserved),
      };
    }
    await compose(p.root, p.project, config, ["up", "-d", "db"]);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await compose(p.root, p.project, config, [
          "exec",
          "-T",
          "db",
          "pg_isready",
          "-U",
          "hackathon",
        ]);
        ready = true;
        break;
      } catch {
        await pause(1000);
      }
    }
    if (!ready) throw new Error("PostgreSQL did not become ready");
    const query = async (sql: string) =>
      compose(p.root, p.project, config, [
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "hackathon",
        "-d",
        "postgres",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ]);
    const exists = await query(`SELECT 1 FROM pg_database WHERE datname = '${p.name}'`);
    if (exists && !(await Bun.file(record).exists()))
      throw new Error(
        `Database ${p.name} already exists without an ownership record; refusing to adopt it`,
      );
    if (!exists) await query(`CREATE DATABASE "${p.name}"`);
    await writeFile(record, JSON.stringify(runtime), { mode: 0o600 });
    await mkdir(resolve(p.root, ".local"), { recursive: true, mode: 0o700 });
    await writeFile(resolve(p.root, ".local/runtime.json"), JSON.stringify(runtime, null, 2), {
      mode: 0o600,
    });
    await writeFile(
      resolve(p.root, ".env.local"),
      [
        `APP_ROOT=${JSON.stringify(runtime.root)}`,
        `DATABASE_URL=${JSON.stringify(runtime.url)}`,
        `TEST_DATABASE_URL=${JSON.stringify(runtime.url)}`,
        `PORT=${runtime.port}`,
        `WEB_PORT=${runtime.webPort}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      resolve(p.root, ".env.test.local"),
      `TEST_DATABASE_URL=${JSON.stringify(runtime.url)}\n`,
      { mode: 0o600 },
    );
    console.log(
      `Runtime ready: database ${runtime.name}, API ${runtime.port}, web ${runtime.webPort}`,
    );
  });
}

async function dropRuntime(): Promise<void> {
  if (!process.argv.includes("--yes"))
    throw new Error("Drop removes this worktree's database. Re-run with drop --yes.");
  const p = await paths();
  await locked(p.shared, async () => {
    const runtime = await validRuntime();
    if (process.env["DATABASE_URL"] && process.env["DATABASE_URL"] !== runtime.url)
      throw new Error("DATABASE_URL differs from the owned database; refusing drop.");
    const config = await readProject(resolve(p.shared, "project.json"));
    await compose(p.root, p.project, config, [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "hackathon",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DROP DATABASE IF EXISTS "${runtime.name}" WITH (FORCE)`,
    ]);
    await rm(resolve(p.shared, `${p.name}.json`));
    await rm(resolve(p.root, ".local/runtime.json"), { force: true });
    await rm(resolve(p.root, ".env.local"), { force: true });
    await rm(resolve(p.root, ".env.test.local"), { force: true });
    console.log(`Dropped ${runtime.name}; shared PostgreSQL remains running.`);
  });
}

if (import.meta.main) {
  const action = process.argv[2];
  if (action === "setup") await setupRuntime();
  else if (action === "status") {
    const r = await validRuntime();
    console.log(
      `Database ${r.name}; API http://127.0.0.1:${r.port}; web http://127.0.0.1:${r.webPort}`,
    );
  } else if (action === "drop") await dropRuntime();
  else throw new Error("Usage: bun scripts/runtime.ts setup|status|drop [--yes]");
}
