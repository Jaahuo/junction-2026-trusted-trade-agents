import { expect, test } from "bun:test";
import { fixtures, type StoredMandate } from "@app/contract";
import type { Source } from "./bridge.ts";
import { saveRules } from "./substitution-rules.ts";

const rule = {
  replaces: "prod_test_original",
  productId: "prod_test_substitute",
  policy: "auto" as const,
  decidedAt: "2026-11-14T10:00:00+00:00",
};

/** A source whose get_mandate answers `current` and whose register_mandate echoes it. */
const sourceWith = (current: StoredMandate) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const source: Source = {
    load: async () => current,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return current;
    },
  };
  return { source, calls };
};

test("saveRules registers the current mandate with the changed rules and its own expiry", async () => {
  const { source, calls } = sourceWith(fixtures.storedMandate);
  const saved = await saveRules(source, (rules) => [...rules, rule]);
  expect(saved.kind).toBe("done");
  const { limits, standingConstraints, exp } = fixtures.storedMandate.mandate;
  expect(calls).toEqual([
    { tool: "get_mandate", args: {} },
    {
      tool: "register_mandate",
      args: { limits: { ...limits, substitutionRules: [rule] }, standingConstraints, exp },
    },
  ]);
});

test("saveRules on a mandate that is not active registers nothing and fails", async () => {
  const { source, calls } = sourceWith({ ...fixtures.storedMandate, status: "revoked" });
  expect((await saveRules(source, (rules) => [...rules, rule])).kind).toBe("error");
  expect(calls.map((call) => call.tool)).toEqual(["get_mandate"]);
});
