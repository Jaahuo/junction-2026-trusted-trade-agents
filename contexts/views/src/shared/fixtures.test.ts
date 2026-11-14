import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { VIEWS } from "@app/contract";
import { parseResult } from "./bridge.ts";

const root = resolve(import.meta.dir, "../../fixtures");
const expected: Record<string, string> = {
  done: "done",
  pending: "done",
  empty: "empty",
  error: "error",
};

test("each view fixture gives the state its name says", async () => {
  for (const entry of VIEWS) {
    const { view } = entry;
    const names = await readdir(resolve(root, view)).catch(() => []);
    for (const name of names) {
      const kind = name.replace(/\.json$/, "");
      const state = parseResult(entry, await Bun.file(resolve(root, view, name)).json());
      expect(`${view}/${name}: ${state.kind}`).toBe(`${view}/${name}: ${expected[kind]}`);
    }
  }
});
