import { expect, test } from "bun:test";
import {
  fixtures,
  type MandateDraft,
  type StoredMandate,
  StoredMandateSchema,
} from "@app/contract";
import type { Source, ViewState } from "../../shared/bridge.ts";
import { setLang } from "../../shared/locale.ts";
import rulesFixture from "../../../fixtures/mandate-settings/rules.json";
import { MandateSettings } from "./mandate-settings.ts";

const isTemplate = (value: unknown): value is { strings: readonly string[]; values: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "strings" in value &&
  "values" in value &&
  Array.isArray(value.strings) &&
  Array.isArray(value.values);

/** The markup and text of a template, without a DOM. */
const textOf = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (!isTemplate(value)) return typeof value === "string" ? value : "";
  return value.strings.map((part, index) => part + textOf(value.values[index])).join("");
};

/** The `@click` handler of the button whose markup contains `marker`. */
const clickHandler = (value: unknown, marker: string): (() => unknown) | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = clickHandler(item, marker);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isTemplate(value)) return undefined;
  if (value.strings.join("").includes(marker)) {
    const index = value.strings.findIndex((part) => part.trimEnd().endsWith("@click="));
    const handler = value.values[index];
    if (typeof handler === "function") return () => handler();
  }
  for (const nested of value.values) {
    const found = clickHandler(nested, marker);
    if (found !== undefined) return found;
  }
  return undefined;
};

class Harness extends MandateSettings {
  show(state: ViewState<StoredMandate | MandateDraft>) {
    this.state = state;
  }
  current() {
    return this.state;
  }
}
customElements.define("tt-mandate-settings-test", Harness);

const registered: StoredMandate = {
  ...fixtures.storedMandate,
  mandate: {
    ...fixtures.storedMandate.mandate,
    mandateId: "mnd_test_2",
    version: 2,
    limits: fixtures.draftMandateRequest.limits,
  },
};

const setup = (answers: (() => Promise<unknown>)[]) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const context: string[] = [];
  const source: Source = {
    load: () => new Promise(() => {}),
    call: async (tool, args) => {
      calls.push({ tool, args });
      const answer = answers.shift();
      if (answer === undefined) throw new Error("no answer");
      return answer();
    },
    context: async (text) => {
      context.push(text);
    },
  };
  const view = new Harness();
  view.source = source;
  view.show({ kind: "done", data: fixtures.mandateDraft });
  const press = async () => {
    const register = clickHandler(view.render(), "btn primary");
    if (register === undefined) throw new Error("the draft shows the Register button");
    await register();
  };
  return { view, calls, context, press };
};

test("a draft shows the proposed limit, the limit in force and the Register button", () => {
  setLang("en");
  const { view } = setup([]);
  const text = textOf(view.render());
  expect(text).toContain('part="draft"');
  expect(text).toContain("Draft · not registered");
  expect(text).toContain("Compared with version 1");
  expect(text).toContain("In force now:");
  expect(text).toContain("Register limits");
  expect(text).not.toContain('part="register-error"');
});

test("Register calls register_mandate with the draft and an operationId, then shows the registered mandate and tells the model", async () => {
  const { view, calls, context, press } = setup([async () => registered]);
  await press();
  expect(calls).toEqual([
    {
      tool: "register_mandate",
      args: { ...fixtures.draftMandateRequest, operationId: expect.stringMatching(/^op_view_/) },
    },
  ]);
  expect(view.current()).toEqual({ kind: "done", data: registered });
  expect(textOf(view.render())).toContain('part="done"');
  expect(context).toEqual([
    "The human registered mandate mnd_test_2 version 2 in the mandate view. Its limits are in force now.",
  ]);
});

const lost = async () => {
  throw new Error("UPSTREAM_FAILED: register answered a response that cannot be read.");
};

const unreachable = async () => {
  throw new Error("The host did not answer.");
};

test("a refused Register keeps the draft, says it failed and retries with the same operationId", async () => {
  setLang("fi");
  const { view, calls, context, press } = setup([
    lost,
    async () => fixtures.storedMandate,
    async () => registered,
  ]);
  await press();
  const failed = textOf(view.render());
  expect(failed).toContain('part="register-error"');
  expect(failed).toContain("UPSTREAM_FAILED: register answered a response that cannot be read.");
  expect(failed).toContain("Rajoja ei rekisteröity");
  expect(context).toEqual([]);

  await press();
  expect(calls.map((call) => call.tool)).toEqual([
    "register_mandate",
    "get_mandate",
    "register_mandate",
  ]);
  expect(calls[2]?.args["operationId"]).toBe(calls[0]?.args["operationId"]);
  expect(view.current()).toEqual({ kind: "done", data: registered });
  setLang("en");
});

test("a lost answer after the register committed shows the registered mandate from get_mandate", async () => {
  const { view, context, press } = setup([lost, async () => registered]);
  await press();
  expect(view.current()).toEqual({ kind: "done", data: registered });
  expect(context).toEqual([expect.stringContaining("Its limits are in force now.")]);
});

test("a lost answer that get_mandate cannot settle says the registration is not confirmed", async () => {
  const { view, context, press } = setup([
    lost,
    async () => {
      throw new Error("The host did not answer.");
    },
  ]);
  await press();
  const text = textOf(view.render());
  expect(text).toContain("Registration is not confirmed");
  expect(text).not.toContain("The limits were not registered");
  expect(text).toContain("The view cannot tell which limits are in force now.");
  expect(text).not.toContain("In force now:");
  expect(text).not.toContain("Compared with version");
  expect(context).toEqual([]);
});

test("after an unsettled check, a retry with the same operationId shows the registered mandate", async () => {
  const { view, calls, press } = setup([lost, unreachable, async () => registered]);
  await press();
  await press();
  expect(calls[2]?.args["operationId"]).toBe(calls[0]?.args["operationId"]);
  expect(view.current()).toEqual({ kind: "done", data: registered });
  expect(textOf(view.render())).not.toContain("cannot tell which limits");
});

test("a failed check that finds another mandate shows that mandate as the one in force", async () => {
  setLang("en");
  const other: StoredMandate = {
    ...fixtures.storedMandate,
    mandate: {
      ...fixtures.storedMandate.mandate,
      mandateId: "mnd_test_3",
      version: 3,
      limits: {
        ...fixtures.storedMandate.mandate.limits,
        maxOrderTotal: { value: 750, currency: "EUR", basis: "gross" },
      },
    },
  };
  const { view, press } = setup([lost, async () => other]);
  await press();
  expect(view.current()).toEqual({
    kind: "done",
    data: { ...fixtures.mandateDraft, current: other },
  });
  const text = textOf(view.render());
  expect(text).toContain("Compared with version 3");
  expect(text).not.toContain("Compared with version 1");
  expect(text).toMatch(/In force now: \D*750\D00/);
  expect(text).not.toMatch(/In force now: \D*1\D000/);
  expect(text).toContain("The limits were not registered");
});

test("a lost answer with no current mandate says the limits were not registered", async () => {
  const { view, press } = setup([
    lost,
    async () => {
      throw new Error("NOT_FOUND: No current mandate.");
    },
  ]);
  await press();
  expect(view.current()).toEqual({
    kind: "done",
    data: { ...fixtures.mandateDraft, current: null },
  });
  const text = textOf(view.render());
  expect(text).toContain("The limits were not registered");
  expect(text).toContain("No mandate is in force now.");
  expect(text).not.toContain("In force now:");
});

test("a replay that returns a revoked mandate does not tell the model it is in force", async () => {
  const { view, context, press } = setup([async () => ({ ...registered, status: "revoked" })]);
  await press();
  expect(textOf(view.render())).toContain("Revoked");
  expect(context).toEqual([expect.stringContaining("revoked and not in force")]);
});

test("a draft whose current mandate has expired shows no limits in force", () => {
  const { view } = setup([]);
  const expired = { ...fixtures.storedMandate.mandate, exp: 1 };
  view.show({
    kind: "done",
    data: { ...fixtures.mandateDraft, current: { ...fixtures.storedMandate, mandate: expired } },
  });
  const text = textOf(view.render());
  expect(text).toContain("No mandate is in force now.");
  expect(text).not.toContain("In force now:");
});

test("an answer outside the contract keeps the draft with an error", async () => {
  const { view, press } = setup([async () => ({ unexpected: true })]);
  await press();
  expect(view.current()).toEqual({ kind: "done", data: fixtures.mandateDraft });
  const text = textOf(view.render());
  expect(text).toContain("register_mandate answered outside the contract.");
  expect(text).toContain("Registration is not confirmed");
});

const withRules = StoredMandateSchema.parse(rulesFixture);

/** A view that shows `stored` and records the tools it calls, each answered with `stored`. */
const showing = (stored: StoredMandate) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const view = new Harness();
  view.source = {
    load: async () => stored,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return stored;
    },
  };
  view.show({ kind: "done", data: stored });
  return { view, calls };
};

test("substitution rules show both directions, each with Remove", () => {
  const shown = textOf(showing(withRules).view.render());
  expect(shown).toContain("Substitution rules");
  expect(shown).toContain(
    "Test plant-based yogurt unsweetened 400 g instead of Test plant-based yogurt 750 g",
  );
  expect(shown).toContain("Ordered without asking");
  expect(shown).toContain("Not suggested");
  expect(shown.match(/>\s*Remove\s*</g)).toHaveLength(2);
});

test("Remove registers the mandate again without that rule, keeping its expiry", async () => {
  const { view, calls } = showing(withRules);
  await clickHandler(view.render(), 'class="btn secondary"')?.();
  expect(calls).toEqual([
    {
      tool: "register_mandate",
      args: {
        limits: {
          ...withRules.mandate.limits,
          substitutionRules: withRules.mandate.limits.substitutionRules?.slice(1),
        },
        standingConstraints: withRules.mandate.standingConstraints,
        exp: withRules.mandate.exp,
      },
    },
  ]);
});

test("a revoked mandate lists its rules without Remove", () => {
  const shown = textOf(showing({ ...withRules, status: "revoked" }).view.render());
  expect(shown).toContain("Substitution rules");
  expect(shown).not.toMatch(/>\s*Remove\s*</);
});
