import { expect, test } from "bun:test";
import { fixtures, type MandateDraft, type StoredMandate } from "@app/contract";
import type { Source, ViewState } from "../../shared/bridge.ts";
import { setLang } from "../../shared/locale.ts";
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

test("a failed Register keeps the draft, shows the error and retries with the same operationId", async () => {
  setLang("fi");
  const { view, calls, context, press } = setup([
    async () => {
      throw new Error("UPSTREAM_FAILED: The mandate service did not answer.");
    },
    async () => registered,
  ]);
  await press();
  const failed = textOf(view.render());
  expect(failed).toContain('part="register-error"');
  expect(failed).toContain("UPSTREAM_FAILED: The mandate service did not answer.");
  expect(failed).toContain("Rajoja ei rekisteröity");
  expect(context).toEqual([]);

  await press();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.args["operationId"]).toBe(calls[0]?.args["operationId"]);
  expect(view.current()).toEqual({ kind: "done", data: registered });
  setLang("en");
});

test("an answer outside the contract keeps the draft with an error", async () => {
  const { view, press } = setup([async () => ({ unexpected: true })]);
  await press();
  expect(view.current()).toEqual({ kind: "done", data: fixtures.mandateDraft });
  expect(textOf(view.render())).toContain("register_mandate answered outside the contract.");
});
