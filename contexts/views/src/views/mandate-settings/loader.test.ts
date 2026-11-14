import { expect, test } from "bun:test";
import { StoredMandateSchema } from "@app/contract";
import type { Source } from "../../shared/bridge.ts";
import mandateFixture from "../../../fixtures/mandate-settings/done.json";
import { loadMandate } from "./loader.ts";

const mandate = StoredMandateSchema.parse(mandateFixture);

test("retry fetches a fresh mandate after an invalid initial host result", async () => {
  const initial = Promise.resolve({ invalid: true });
  let loads = 0;
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const source: Source = {
    load: () => {
      loads++;
      return initial;
    },
    call: async (tool, args) => {
      calls.push({ tool, args });
      return mandate;
    },
  };

  expect((await loadMandate(source)).kind).toBe("error");
  expect(await loadMandate(source, true)).toEqual({ kind: "done", data: mandate });
  expect(loads).toBe(1);
  expect(calls).toEqual([{ tool: "get_mandate", args: {} }]);
});

test("initial and retry failures distinguish current mandate 404 from errors", async () => {
  for (const retry of [false, true]) {
    for (const [message, kind] of [
      ["GET /api/mandates/current answered 404.", "empty"],
      ["GET /api/mandates/current answered 500.", "error"],
      ["GET /other answered 404.", "error"],
    ] as const) {
      const fail = async () => {
        throw new Error(message);
      };
      const source: Source = { load: fail, call: fail };
      expect((await loadMandate(source, retry)).kind).toBe(kind);
    }
    const invalid: Source = { load: async () => ({}), call: async () => ({}) };
    expect((await loadMandate(invalid, retry)).kind).toBe("error");
  }
});
