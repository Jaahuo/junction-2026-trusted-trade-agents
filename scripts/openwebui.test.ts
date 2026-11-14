import { expect, test } from "bun:test";
import {
  buildSystemPrompt,
  extractPrompt,
  hasConnection,
  mergeConnections,
  modelPayload,
  parseEnv,
  toolServer,
} from "./openwebui.ts";

test("reads the prompt block from the document", async () => {
  const prompt = extractPrompt(
    await Bun.file(`${import.meta.dir}/../docs/buyer-agent-prompt.md`).text(),
  );
  expect(prompt.startsWith("# How you talk and act")).toBe(true);
  expect(prompt).toContain("BAD REPLIES");
  expect(prompt).not.toContain("```");
});

test("refuses a document without a prompt block", () => {
  expect(() => extractPrompt("# Title\n\n```sh\nls\n```\n")).toThrow("no ```text prompt block");
});

test("builds the system prompt from the skill and the prompt", () => {
  expect(buildSystemPrompt("skill text\n\n", "\nprompt text")).toBe("skill text\n\nprompt text\n");
});

test("replaces the trusted-trade connection and keeps the others", () => {
  const other = { url: "http://other.example/mcp", info: { id: "other" } };
  const old = toolServer("http://host.docker.internal:1/mcp");
  const ours = toolServer("http://host.docker.internal:2/mcp");
  expect(mergeConnections([old, other], ours)).toEqual([other, ours]);
  expect(mergeConnections([other, ours], ours)).toEqual([other, ours]);
});

test("a second setup run finds its connection although the server added fields", () => {
  const stored = { ...toolServer("http://host.docker.internal:2/mcp"), headers: null };
  expect(hasConnection([stored], "http://host.docker.internal:2/mcp")).toBe(true);
  expect(hasConnection([stored], "http://host.docker.internal:3/mcp")).toBe(false);
  expect(hasConnection([], "http://host.docker.internal:2/mcp")).toBe(false);
});

test("the model uses the tool server and native function calling", () => {
  const payload = modelPayload("base", "system");
  expect(payload["base_model_id"]).toBe("base");
  expect(payload["params"]).toEqual({ system: "system", function_calling: "native" });
  expect(payload["meta"]).toMatchObject({ toolIds: ["server:mcp:trusted-trade"] });
});

test("parses KEY=value lines and skips comments", () => {
  expect(parseEnv("# note\nOPENWEBUI_PORT=38090\n\nEMPTY=\n bad line\n")).toEqual({
    OPENWEBUI_PORT: "38090",
    EMPTY: "",
  });
});
