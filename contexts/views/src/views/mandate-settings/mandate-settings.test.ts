import { expect, test } from "bun:test";
import { type StoredMandate, StoredMandateSchema } from "@app/contract";
import rulesFixture from "../../../fixtures/mandate-settings/rules.json";
import type { Source } from "../../shared/bridge.ts";
import { clickHandler, markup } from "../approval-card/template-walk.ts";
import { MandateSettings } from "./mandate-settings.ts";

const record = StoredMandateSchema.parse(rulesFixture);

/** Sets the loaded state directly, as the view does after a load. */
class ShownSettings extends MandateSettings {
  show(data: StoredMandate) {
    this.state = { kind: "done", data };
  }
}

const viewWith = (data: StoredMandate) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const view = new ShownSettings();
  view.source = {
    load: async () => data,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return data;
    },
  } satisfies Source;
  view.show(data);
  return { view, calls };
};

test("substitution rules show both directions, each with Remove", () => {
  const shown = markup(viewWith(record).view.render());
  expect(shown).toContain("Substitution rules");
  expect(shown).toContain(
    "Test plant-based yogurt unsweetened 400 g instead of Test plant-based yogurt 750 g",
  );
  expect(shown).toContain("Ordered without asking");
  expect(shown).toContain("Not suggested");
  expect(shown.match(/>\s*Remove\s*</g)).toHaveLength(2);
});

test("Remove registers the mandate again without that rule, keeping its expiry", async () => {
  const { view, calls } = viewWith(record);
  clickHandler(view.render(), 'class="btn secondary"')?.();
  await Promise.resolve();
  expect(calls).toEqual([
    {
      tool: "register_mandate",
      args: {
        limits: {
          ...record.mandate.limits,
          substitutionRules: record.mandate.limits.substitutionRules?.slice(1),
        },
        standingConstraints: record.mandate.standingConstraints,
        exp: record.mandate.exp,
      },
    },
  ]);
});

test("a revoked mandate lists its rules without Remove", () => {
  const shown = markup(viewWith({ ...record, status: "revoked" }).view.render());
  expect(shown).toContain("Substitution rules");
  expect(shown).not.toMatch(/>\s*Remove\s*</);
});
