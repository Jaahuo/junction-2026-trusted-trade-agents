import { $ } from "bun";
import { assertDevPortsAvailable, loadRuntime } from "./runtime.ts";

await loadRuntime();
await assertDevPortsAvailable();

await Promise.all([$`bun --hot apps/api/src/main.ts`, $`bunx vp dev`.cwd("apps/web")]);
