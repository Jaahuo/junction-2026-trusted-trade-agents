// Runs chat sentences in the Open WebUI host and reports what the agent did with the tools.
// Usage: bun scripts/host-check.ts [--only <name>] [--scenarios <file>] [--api <url>] [--no-reset] [--headed] [--timeout <seconds>]
// The host must run (bun scripts/openwebui.ts up) and point at the server under test.
import { chromium, type Page } from "playwright-core";
import { parseEnv } from "./openwebui.ts";
import { loadRuntime } from "./runtime.ts";

const ROOT = `${import.meta.dir}/..`;
const HOST_DIR = `${ROOT}/hosts/openwebui`;
const OUT_DIR = `${ROOT}/.local/host-check`;
const SERVER_ID = "trusted-trade";
const MODEL_ID = "buyer-agent";
const USAGE =
  "Usage: bun scripts/host-check.ts [--only <name>] [--scenarios <file>] [--api <url>] [--no-reset] [--headed] [--timeout <seconds>]";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export type Step = { say: string } | { click: string } | { dialog: "confirm" | "cancel" };

type Check =
  | { called: string }
  | { notCalled: string }
  | { noError: string }
  | { order: "placed" | "pending_approval" | "rejected" | "any" | "none"; reason?: string }
  | { maxOrders: number };

/** `known` names the issue that tracks a failure the team accepts for now. */
export type Expectation = Check & { known?: string };

export interface Scenario {
  name: string;
  steps: Step[];
  expect: Expectation[];
}

export interface ToolCall {
  tool: string;
  args: Json;
  /** The error code of a refused call, `NO_RESULT` when the chat stores none, or null. */
  error: string | null;
  text: string;
}

/** One message of the person (or of a view) and what the agent did with it. */
export interface Turn {
  said: string;
  calls: ToolCall[];
  reply: string;
}

export interface Trace {
  turns: Turn[];
  /** The calls of every turn, in order. */
  calls: ToolCall[];
  /** The agent's reply in the last turn. */
  reply: string;
}

export interface OrderState {
  orderId: string;
  status: string;
  reasons: string[];
}

function parseStep(value: unknown): Step {
  if (isObject(value)) {
    if (typeof value["say"] === "string") return { say: value["say"] };
    if (typeof value["click"] === "string") return { click: value["click"] };
    if (value["dialog"] === "confirm" || value["dialog"] === "cancel")
      return { dialog: value["dialog"] };
  }
  throw new Error(`Unknown step: ${JSON.stringify(value)}`);
}

function parseCheck(value: unknown): Check {
  if (isObject(value)) {
    if (typeof value["called"] === "string") return { called: value["called"] };
    if (typeof value["notCalled"] === "string") return { notCalled: value["notCalled"] };
    if (typeof value["noError"] === "string") return { noError: value["noError"] };
    if (typeof value["maxOrders"] === "number") return { maxOrders: value["maxOrders"] };
    const order = value["order"];
    if (
      order === "placed" ||
      order === "pending_approval" ||
      order === "rejected" ||
      order === "any" ||
      order === "none"
    )
      return typeof value["reason"] === "string" ? { order, reason: value["reason"] } : { order };
  }
  throw new Error(`Unknown expectation: ${JSON.stringify(value)}`);
}

function parseExpectation(value: unknown): Expectation {
  const check = parseCheck(value);
  return isObject(value) && typeof value["known"] === "string"
    ? { ...check, known: value["known"] }
    : check;
}

/** Reads a scenario file; an unknown step or expectation is an error, not a skipped check. */
export function parseScenarios(text: string): Scenario[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || data.length === 0)
    throw new Error("The scenario file must be a list.");
  return data.map((entry) => {
    if (!isObject(entry) || typeof entry["name"] !== "string" || entry["name"] === "")
      throw new Error("Each scenario needs a name.");
    const scenario: Scenario = {
      name: entry["name"],
      steps: asArray(entry["steps"]).map(parseStep),
      expect: asArray(entry["expect"]).map(parseExpectation),
    };
    if (scenario.steps.length === 0) throw new Error(`Scenario ${scenario.name} has no steps.`);
    return scenario;
  });
}

/** The messages of a stored Open WebUI chat, oldest first, along the branch the page shows. */
function branch(chat: unknown): Json[] {
  const history = isObject(chat) && isObject(chat["chat"]) ? chat["chat"]["history"] : undefined;
  if (!isObject(history) || !isObject(history["messages"])) return [];
  const messages = history["messages"];
  const path: Json[] = [];
  let id: unknown = history["currentId"];
  while (typeof id === "string" && path.length < 1000) {
    const message = messages[id];
    if (!isObject(message)) break;
    path.unshift(message);
    id = message["parentId"];
  }
  return path;
}

/** A refused tool call's result is `{ "error": "<CODE>: <message>…" }`; anything else passed. */
function errorCode(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return /^Error\b/i.test(text) ? "HOST_ERROR" : null;
  }
  if (!isObject(parsed) || typeof parsed["error"] !== "string") return null;
  return /^([A-Z][A-Z0-9_]+):/.exec(parsed["error"])?.[1] ?? "ERROR";
}

const textOf = (parts: unknown): string =>
  asArray(parts)
    .map((part) => (isObject(part) ? asString(part["text"]) : ""))
    .join("");

function readCall(item: Json): ToolCall {
  let args: unknown;
  try {
    args = JSON.parse(asString(item["arguments"]));
  } catch {
    args = {};
  }
  const name = asString(item["name"]);
  return {
    tool: name.startsWith(`${SERVER_ID}_`) ? name.slice(SERVER_ID.length + 1) : name,
    args: isObject(args) ? args : {},
    error: "NO_RESULT",
    text: "",
  };
}

/** The turns of a stored Open WebUI chat: each message, the tool calls with results and the reply. */
export function readTrace(chat: unknown): Trace {
  const turns: Turn[] = [];
  const pending = new Map<string, ToolCall>();
  let said = "";
  for (const message of branch(chat)) {
    if (message["role"] !== "assistant") {
      said = asString(message["content"]);
      continue;
    }
    const turn: Turn = { said, calls: [], reply: "" };
    for (const item of asArray(message["output"]).filter(isObject)) {
      if (item["type"] === "function_call") {
        const call = readCall(item);
        turn.calls.push(call);
        pending.set(asString(item["call_id"]), call);
      } else if (item["type"] === "function_call_output") {
        const call = pending.get(asString(item["call_id"]));
        if (call) {
          call.text = textOf(item["output"]);
          call.error = errorCode(call.text);
        }
      } else if (item["type"] === "message") {
        const text = textOf(item["content"]).trim();
        if (text !== "") turn.reply = text.replace(/\s+/g, " ");
      }
    }
    turns.push(turn);
  }
  return { turns, calls: turns.flatMap((turn) => turn.calls), reply: turns.at(-1)?.reply ?? "" };
}

const TOKEN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

const distance = (a: string, b: string): number => {
  let differing = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) differing++;
  return differing;
};

/**
 * Says how a token that the agent sent differs from the tokens the server issued in the chat.
 * A model that copies a signed token by hand changes or drops characters; the server then refuses it.
 */
export function tokenCopy(sent: string, issued: readonly string[]): string {
  if (issued.includes(sent)) return "exact copy";
  if (issued.length === 0) return "no token was issued in this chat";
  const nearest = issued.reduce((best, token) =>
    distance(sent, token) < distance(sent, best) ? token : best,
  );
  return sent.length === nearest.length
    ? `miscopied: ${distance(sent, nearest)} of ${nearest.length} characters differ`
    : `miscopied: ${sent.length} characters sent, ${nearest.length} issued`;
}

/** The tokens in the results of the calls before `index`. */
const issuedBefore = (calls: readonly ToolCall[], index: number): string[] =>
  calls.slice(0, index).flatMap((call) => call.text.match(TOKEN) ?? []);

function describeCall(call: ToolCall, issued: readonly string[]): string {
  if (call.error === null) return `${call.tool} ok`;
  if (call.error === "NO_RESULT") return `${call.tool} ERROR NO_RESULT, the chat stores no result`;
  if (call.error === "HOST_ERROR")
    return `${call.tool} ERROR HOST_ERROR, ${call.text.slice(0, 120)}`;
  const copies =
    call.tool === "place_order"
      ? asArray(call.args["offers"])
          .filter((offer): offer is string => typeof offer === "string")
          .map((offer) => tokenCopy(offer, issued))
      : [];
  return `${call.tool} ERROR ${call.error}${copies.length > 0 ? `, token ${copies.join("; token ")}` : ""}`;
}

/**
 * One line per tool call from `from` on, with equal lines in a row counted once.
 * A refused place_order also says whether the token was copied right.
 */
export function describeCalls(
  calls: readonly ToolCall[],
  from = 0,
  count = calls.length,
): string[] {
  const lines: { text: string; times: number }[] = [];
  calls.slice(from, from + count).forEach((call, offset) => {
    const text = describeCall(call, issuedBefore(calls, from + offset));
    const previous = lines.at(-1);
    if (previous?.text === text) previous.times++;
    else lines.push({ text, times: 1 });
  });
  return lines.map((line) => (line.times > 1 ? `${line.text} (${line.times} times)` : line.text));
}

/** The ids of the orders that place_order created, in call order and without repeats. */
export function orderIds(calls: readonly ToolCall[]): string[] {
  const ids = calls
    .filter((call) => call.tool === "place_order" && call.error === null)
    .map((call) => /ord_[0-9a-f-]{36}/.exec(call.text)?.[0])
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}

const label = (expectation: Expectation): string => {
  if ("called" in expectation) return `called ${expectation.called}`;
  if ("notCalled" in expectation) return `did not call ${expectation.notCalled}`;
  if ("noError" in expectation) return `no ${expectation.noError}`;
  if ("maxOrders" in expectation) return `at most ${expectation.maxOrders} order(s)`;
  return `order ${expectation.order}${expectation.reason ? ` with ${expectation.reason}` : ""}`;
};

/** Checks one expectation against the tool calls and the stored orders; null means it holds. */
function failure(
  expectation: Expectation,
  trace: Trace,
  orders: readonly OrderState[],
): string | null {
  const count = (tool: string) => trace.calls.filter((call) => call.tool === tool).length;
  if ("called" in expectation) return count(expectation.called) > 0 ? null : "it was not called";
  if ("notCalled" in expectation) {
    const calls = count(expectation.notCalled);
    return calls === 0 ? null : `it was called ${calls} time(s)`;
  }
  if ("noError" in expectation) {
    const refused = trace.calls.filter((call) => call.error === expectation.noError);
    return refused.length === 0 ? null : `${refused.length} call(s) got it`;
  }
  if ("maxOrders" in expectation)
    return orders.length <= expectation.maxOrders ? null : `${orders.length} orders were created`;
  const last = orders.at(-1);
  if (expectation.order === "any") return last === undefined ? "no order was created" : null;
  if (expectation.order === "none")
    return last === undefined ? null : `order ${last.orderId} is ${last.status}`;
  if (last === undefined) return "no order was created";
  const got = `got ${last.status} [${last.reasons.join(", ") || "no reasons"}]`;
  if (last.status !== expectation.order) return got;
  return expectation.reason === undefined || last.reasons.includes(expectation.reason) ? null : got;
}

export interface Verdict {
  label: string;
  failure: string | null;
  known?: string;
}

/** Without every step done and a finished reply the other expectations say nothing. */
function finished(trace: Trace, problems: readonly string[]): Verdict {
  const lost = trace.calls.filter(
    (call) => call.error === "HOST_ERROR" || call.error === "NO_RESULT",
  ).length;
  let problem: string | null = null;
  if (problems.length > 0) problem = problems.join("; ");
  else if (lost > 0) problem = `${lost} tool call(s) got no result from the host`;
  else if (trace.reply === "") problem = "the agent gave no reply";
  return { label: "every step ran and the agent replied", failure: problem };
}

/** `problems` are the steps that could not run, for example a button that is not there. */
export const judge = (
  expectations: readonly Expectation[],
  trace: Trace,
  orders: readonly OrderState[],
  problems: readonly string[] = [],
): Verdict[] => [
  finished(trace, problems),
  ...expectations.map((expectation) => {
    const verdict: Verdict = {
      label: label(expectation),
      failure: failure(expectation, trace, orders),
    };
    if (expectation.known !== undefined) verdict.known = expectation.known;
    return verdict;
  }),
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);

/** True when the host's MCP URL is the `/mcp` of `api`; a container reaches this machine by an alias. */
export function sameServer(mcpUrl: string, api: string): boolean {
  const mcp = new URL(mcpUrl);
  const server = new URL(api);
  const sameHost =
    mcp.hostname === server.hostname ||
    (LOCAL_HOSTS.has(mcp.hostname) && LOCAL_HOSTS.has(server.hostname));
  const path = `${server.pathname.replace(/\/$/, "")}/mcp`;
  return sameHost && mcp.port === server.port && mcp.pathname === path;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(args: string[]) {
  const options = {
    only: undefined as string | undefined,
    scenarios: `${HOST_DIR}/scenarios.json`,
    api: undefined as string | undefined,
    reset: true,
    headed: false,
    timeoutMs: 480_000,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => args[++i] ?? fail(`${arg} needs a value.\n${USAGE}`);
    if (arg === "--only") options.only = value();
    else if (arg === "--scenarios") options.scenarios = value();
    else if (arg === "--api") options.api = value().replace(/\/+$/, "");
    else if (arg === "--no-reset") options.reset = false;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--timeout") options.timeoutMs = Number(value()) * 1000;
    else fail(`Unknown option ${arg}.\n${USAGE}`);
  }
  if (!(options.timeoutMs > 0)) fail(`--timeout must be a number of seconds.\n${USAGE}`);
  return options;
}

const getJson = async (url: string, token?: string): Promise<unknown> => {
  const response = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
};

const reachable = (url: string): Promise<boolean> =>
  fetch(url)
    .then((response) => response.ok)
    .catch(() => false);

/** Stops with the cause when the host cannot give a result that says something about `api`. */
async function preflight(host: string, api: string): Promise<string> {
  if (!(await reachable(`${api}/api/health`)))
    fail(`The server under test does not answer at ${api}. Start it with bun run production.`);
  const tools = await fetch(`${api}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
    .then((response) => response.text())
    .catch(() => "");
  if (!tools.includes('"place_order"'))
    fail(`The MCP endpoint at ${api}/mcp does not list the order tools.`);
  if (!(await reachable(`${host}/health`)))
    fail(`Open WebUI does not answer at ${host}. Start it with bun scripts/openwebui.ts up.`);
  const signin = await fetch(`${host}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "", password: "" }),
  });
  const session: unknown = await signin.json().catch(() => null);
  const token = isObject(session) ? asString(session["token"]) : "";
  if (token === "") fail("Open WebUI gave no session. This check needs WEBUI_AUTH=False.");

  const servers = await getJson(`${host}/api/v1/configs/tool_servers`, token);
  const connection = asArray(isObject(servers) ? servers["TOOL_SERVER_CONNECTIONS"] : [])
    .filter(isObject)
    .find((entry) => isObject(entry["info"]) && entry["info"]["id"] === SERVER_ID);
  const url = connection ? asString(connection["url"]) : "";
  if (url === "")
    fail("Open WebUI has no trusted-trade tool server. Run bun scripts/openwebui.ts setup.");
  if (isObject(connection?.["config"]) && connection["config"]["enable"] === false)
    fail("The trusted-trade tool server is switched off in Open WebUI.");
  if (!sameServer(url, api))
    fail(
      `Open WebUI is connected to ${url}, not to the server under test at ${api}.\n` +
        "Set OPENWEBUI_MCP_URL in hosts/openwebui/.env (or empty it) and run bun scripts/openwebui.ts setup, or pass --api.",
    );

  const models = await getJson(`${host}/api/models`, token);
  const ids = new Set(
    asArray(isObject(models) ? models["data"] : []).map((model) =>
      isObject(model) ? asString(model["id"]) : "",
    ),
  );
  if (!ids.has(MODEL_ID))
    fail('Open WebUI has no "Buyer agent" model. Run bun scripts/openwebui.ts setup.');
  const model = await getJson(`${host}/api/v1/models/model?id=${MODEL_ID}`, token);
  const base = isObject(model) ? asString(model["base_model_id"]) : "";
  if (!ids.has(base))
    fail(
      `The model endpoint does not list ${base}. It is down or busy; Open WebUI would answer "Model not found".`,
    );
  return token;
}

async function resetDatabase(): Promise<void> {
  const child = Bun.spawn(["bun", "run", "--silent", "db:reset"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) fail("bun run db:reset failed.");
}

const pendingDialog = async (page: Page): Promise<string | null> => {
  if ((await page.getByRole("button", { name: "Confirm", exact: true }).count()) === 0) return null;
  const text = await page
    .getByText("Tool call", { exact: true })
    .last()
    .locator("xpath=..")
    .innerText()
    .catch(() => "Tool call");
  return text.replace(/\s+/g, " ").replace(/ Cancel Confirm$/, "");
};

const answerDialog = (page: Page, answer: "confirm" | "cancel"): Promise<void> =>
  page
    .getByRole("button", { name: answer === "confirm" ? "Confirm" : "Cancel", exact: true })
    .last()
    .click();

/** A view may ask for a tool call on its own; the dialog would block the next step. */
async function cancelUnasked(page: Page, notes: string[]): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const dialog = await pendingDialog(page);
    if (dialog === null) return;
    notes.push(`unasked dialog cancelled: ${dialog}`);
    await answerDialog(page, "cancel");
    await page.waitForTimeout(1500);
  }
}

/** `name` is a pattern, because a card names its main button by the order's state. */
async function clickInView(page: Page, name: string): Promise<boolean> {
  for (const frame of page.frames().toReversed()) {
    const button = frame.getByRole("button", { name: new RegExp(name, "i") }).last();
    if ((await button.count().catch(() => 0)) === 0) continue;
    // The page keeps scrolling while views load, so a pointer click never finds the button at rest.
    await button.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
    return true;
  }
  return false;
}

interface Run {
  trace: Trace;
  notes: string[];
  /** The steps that could not run. */
  problems: string[];
  /** The seconds each `say` step took, by sentence. */
  took: Map<string, number>;
  seconds: number;
}

async function runScenario(
  page: Page,
  scenario: Scenario,
  host: string,
  token: string,
  timeoutMs: number,
): Promise<Run> {
  const started = Date.now();
  const notes: string[] = [];
  const problems: string[] = [];
  const took = new Map<string, number>();
  await page.goto(`${host}/?models=${MODEL_ID}`, { waitUntil: "domcontentloaded" });
  await page.locator("#chat-input").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);

  const chat = async (): Promise<unknown> => {
    const id = page.url().split("/c/")[1];
    return id === undefined ? null : getJson(`${host}/api/v1/chats/${id}`, token).catch(() => null);
  };
  // The stop button is no reliable sign of the end; the stored message's `done` flag is.
  const settle = async (after: number, mustGrow: boolean): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    const growBy = Date.now() + 20_000;
    let stable = 0;
    while (stable < 2) {
      if (Date.now() > deadline) {
        problems.push(`no finished reply within ${timeoutMs / 1000} s`);
        return;
      }
      await page.waitForTimeout(3000);
      const messages = branch(await chat());
      if (messages.length <= after) {
        if (!mustGrow && Date.now() > growBy) return;
        continue;
      }
      const last = messages.at(-1);
      stable = last?.["role"] === "assistant" && last["done"] === true ? stable + 1 : 0;
    }
    await page.waitForTimeout(2000);
  };

  for (const step of scenario.steps) {
    const before = branch(await chat()).length;
    if ("say" in step) {
      await cancelUnasked(page, notes);
      const sent = Date.now();
      await page.locator("#chat-input").click();
      await page.keyboard.type(step.say);
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/c\//, { timeout: 30_000 }).catch(() => undefined);
      await settle(before, true);
      took.set(step.say, Math.round((Date.now() - sent) / 1000));
    } else if ("click" in step) {
      await cancelUnasked(page, notes);
      if (!(await clickInView(page, step.click)))
        problems.push(`no "${step.click}" button in a view`);
      await page.waitForTimeout(3000);
    } else {
      const dialog = await pendingDialog(page);
      if (dialog === null) problems.push(`no dialog to ${step.dialog}`);
      else {
        notes.push(`dialog ${step.dialog}: ${dialog}`);
        await answerDialog(page, step.dialog);
        // A decision makes the card send a chat message, and the agent answers it. Other tool
        // calls of a view add no message, so the wait for a new one ends after 20 s.
        await settle(before, false);
      }
    }
  }
  await page.screenshot({ path: `${OUT_DIR}/${scenario.name}.png` });
  return {
    trace: readTrace(await chat()),
    notes,
    problems,
    took,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

async function orderStates(api: string, ids: readonly string[]): Promise<OrderState[]> {
  const states: OrderState[] = [];
  for (const orderId of ids) {
    const order = await getJson(`${api}/api/orders/${orderId}`).catch(() => null);
    // An order that cannot be read still counts as created.
    if (!isObject(order)) {
      states.push({ orderId, status: "unreadable", reasons: [] });
      continue;
    }
    states.push({
      orderId,
      status: asString(order["status"]),
      reasons: asArray(order["reasons"]).filter(
        (reason): reason is string => typeof reason === "string",
      ),
    });
  }
  return states;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const all = parseScenarios(await Bun.file(options.scenarios).text());
  const scenarios = options.only ? all.filter((scenario) => scenario.name === options.only) : all;
  if (scenarios.length === 0)
    fail(`No scenario named ${options.only}. Known: ${all.map((s) => s.name).join(", ")}.`);

  const envFile = Bun.file(`${HOST_DIR}/.env`);
  const env = (await envFile.exists()) ? parseEnv(await envFile.text()) : {};
  const host = `http://127.0.0.1:${env["OPENWEBUI_PORT"] || "38090"}`;
  let api = options.api;
  if (api === undefined) {
    await loadRuntime();
    api = `http://127.0.0.1:${process.env["PORT"]}`;
  }
  const token = await preflight(host, api);
  // This worktree can reset only its own database.
  const reset = options.reset && options.api === undefined;
  console.log(
    `host check: Open WebUI ${host} with the server at ${api}${reset ? "" : "; the database is not reset"}`,
  );

  await Bun.$`mkdir -p ${OUT_DIR}`.quiet();
  const browser = await chromium
    .launch({ channel: "chrome", headless: !options.headed })
    .catch(() => fail("Google Chrome did not start. This check drives the installed Chrome."));
  let passed = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    for (const scenario of scenarios) {
      if (reset) await resetDatabase();
      const run = await runScenario(page, scenario, host, token, options.timeoutMs);
      const orders = await orderStates(api, orderIds(run.trace.calls));
      const verdicts = judge(scenario.expect, run.trace, orders, run.problems);
      console.log(`\n${scenario.name} (${run.seconds} s)`);
      let from = 0;
      for (const turn of run.trace.turns) {
        const seconds = run.took.get(turn.said);
        console.log(`  > ${turn.said}${seconds === undefined ? "" : ` (${seconds} s)`}`);
        for (const line of describeCalls(run.trace.calls, from, turn.calls.length))
          console.log(`    ${line}`);
        console.log(`    reply: ${turn.reply || "(none)"}`);
        from += turn.calls.length;
      }
      for (const note of run.notes) console.log(`  ${note}`);
      for (const order of orders)
        console.log(
          `  order ${order.orderId} ${order.status} [${order.reasons.join(", ") || "no reasons"}]`,
        );
      for (const verdict of verdicts)
        console.log(
          verdict.failure === null
            ? `  ok   ${verdict.label}`
            : `  FAIL ${verdict.label}: ${verdict.failure}${verdict.known ? ` (known: ${verdict.known})` : ""}`,
        );
      if (verdicts.every((verdict) => verdict.failure === null)) passed++;
    }
  } finally {
    await browser.close();
  }
  console.log(
    `\n${passed} of ${scenarios.length} scenarios passed. Screenshots: .local/host-check/`,
  );
  if (passed < scenarios.length) process.exit(1);
}

if (import.meta.main) await main();
