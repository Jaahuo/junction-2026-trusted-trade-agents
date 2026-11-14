import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { VIEWS } from "@app/contract";
import { parseResult } from "./bridge.ts";

const root = resolve(import.meta.dir, "../../fixtures");
/** The state a fixture's name promises: `error*`, `*empty*`, or done for everything else. */
const expected = (name: string) =>
  name.startsWith("error") ? "error" : name.includes("empty") ? "empty" : "done";

test("each view fixture gives the state its name says", async () => {
  for (const entry of VIEWS) {
    const { view } = entry;
    const names = await readdir(resolve(root, view)).catch(() => []);
    for (const name of names) {
      const state = parseResult(entry, await Bun.file(resolve(root, view, name)).json());
      expect(`${view}/${name}: ${state.kind}`).toBe(`${view}/${name}: ${expected(name)}`);
    }
  }
});
