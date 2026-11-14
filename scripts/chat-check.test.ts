import { expect, test } from "bun:test";
import {
  describeCalls,
  judge,
  orderIds,
  parseScenarios,
  readTrace,
  sameServer,
  tokenCopy,
  type Expectation,
  type OrderState,
  type Trace,
} from "./chat-check.ts";

// The shape of a stored Open WebUI 0.13.3 chat, from a recorded run; ids and tokens are invented.
// Built from parts so that it has the shape of a signed token without being one.
const TOKEN = [`eyJ${"h".repeat(24)}`, `eyJ${"p".repeat(40)}`, "s".repeat(24)].join(".");
const ORDER = "ord_00000000-1111-2222-3333-444444444444";
const output = (callId: string, text: string) => ({
  type: "function_call_output",
  call_id: callId,
  output: [{ type: "input_text", text }],
});
const call = (callId: string, name: string, args: unknown) => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});
const chat = (sentToken: string, placeResult: string) => ({
  chat: {
    history: {
      currentId: "m2",
      messages: {
        m1: { id: "m1", parentId: null, role: "user", content: "milk" },
        stale: { id: "stale", parentId: "m1", role: "assistant", output: [call("x", "other", {})] },
        m2: {
          id: "m2",
          parentId: "m1",
          role: "assistant",
          done: true,
          output: [
            { type: "reasoning", content: [{ type: "output_text", text: "thinking" }] },
            call("c1", "trusted-trade_get_offers", { lines: [] }),
            output("c1", JSON.stringify({ results: ["1 signed offers", { token: TOKEN }] })),
            call("c2", "trusted-trade_place_order", { offers: [sentToken] }),
            output("c2", placeResult),
            call("c3", "get_current_timestamp", {}),
            output("c3", '{"current_timestamp":1}'),
            { type: "message", content: [{ type: "output_text", text: "\n\nDone.\n" }] },
          ],
        },
      },
    },
  },
});
const placed = JSON.stringify({ results: [`Order ${ORDER}: placed`, { orderId: ORDER }] });
const refused = JSON.stringify({ error: "OFFER_INVALID: An offer token failed verification." });

test("reads the tool calls of the shown branch, without the server prefix", () => {
  const trace = readTrace(chat(TOKEN, placed));
  expect(trace.calls.map((c) => c.tool)).toEqual([
    "get_offers",
    "place_order",
    "get_current_timestamp",
  ]);
  expect(trace.calls.map((c) => c.error)).toEqual([null, null, null]);
  expect(trace.reply).toBe("Done.");
  expect(trace.turns.map((turn) => [turn.said, turn.calls.length, turn.reply])).toEqual([
    ["milk", 3, "Done."],
  ]);
});

test("a call with no stored result is not ok", () => {
  const stored = chat(TOKEN, placed);
  stored.chat.history.messages.m2.output.splice(4, 1);
  const trace = readTrace(stored);
  expect(trace.calls[1]?.error).toBe("NO_RESULT");
  expect(judge([], trace, [])[0]?.failure).toBe("1 tool call(s) got no result from the host");
});

test("reads the error code of a refused call", () => {
  expect(readTrace(chat(TOKEN, refused)).calls[1]?.error).toBe("OFFER_INVALID");
});

test("a host error that is not JSON is an error", () => {
  const trace = readTrace(chat(TOKEN, "Error: the model response was incomplete"));
  expect(trace.calls[1]?.error).toBe("HOST_ERROR");
});

test("a chat with no history gives an empty trace", () => {
  expect(readTrace(null)).toEqual({ turns: [], calls: [], reply: "" });
  expect(readTrace({ chat: {} })).toEqual({ turns: [], calls: [], reply: "" });
});

test("says how a sent token differs from the issued ones", () => {
  expect(tokenCopy(TOKEN, [TOKEN])).toBe("exact copy");
  expect(tokenCopy(`${TOKEN.slice(0, 30)}X${TOKEN.slice(31)}`, ["eyJ.other.token", TOKEN])).toBe(
    `miscopied: 1 of ${TOKEN.length} characters differ`,
  );
  expect(tokenCopy(TOKEN.slice(0, -4), [TOKEN])).toBe(
    `miscopied: ${TOKEN.length - 4} characters sent, ${TOKEN.length} issued`,
  );
  expect(tokenCopy(TOKEN, [])).toBe("no token was issued in this chat");
});

test("a refused place_order line names the miscopied token", () => {
  const changed = `${TOKEN.slice(0, 30)}X${TOKEN.slice(31)}`;
  expect(describeCalls(readTrace(chat(changed, refused)).calls)).toEqual([
    "get_offers ok",
    `place_order ERROR OFFER_INVALID, token miscopied: 1 of ${TOKEN.length} characters differ`,
    "get_current_timestamp ok",
  ]);
});

test("finds the orders that place_order created, and none for a refused call", () => {
  expect(orderIds(readTrace(chat(TOKEN, placed)).calls)).toEqual([ORDER]);
  expect(orderIds(readTrace(chat(TOKEN, refused)).calls)).toEqual([]);
});

const trace: Trace = readTrace(chat(TOKEN, placed));
const pending: OrderState = {
  orderId: ORDER,
  status: "pending_approval",
  reasons: ["SPEND_OVER_LIMIT"],
};
// The first verdict is the built-in "finished with a reply" check.
const failures = (expectations: Parameters<typeof judge>[0], orders: OrderState[]) =>
  judge(expectations, trace, orders)
    .slice(1)
    .map((verdict) => verdict.failure);

test("expectations about tool calls", () => {
  expect(
    failures([{ called: "place_order" }, { notCalled: "decide_approval" }, { noError: "X" }], []),
  ).toEqual([null, null, null]);
  expect(failures([{ called: "decide_approval" }, { notCalled: "place_order" }], [])).toEqual([
    "it was not called",
    "it was called 1 time(s)",
  ]);
  const refusedTrace = readTrace(chat(TOKEN, refused));
  expect(judge([{ noError: "OFFER_INVALID", known: "#1" }], refusedTrace, [])[1]).toEqual({
    label: "no OFFER_INVALID",
    failure: "1 call(s) got it",
    known: "#1",
  });
});

test("expectations about the stored order", () => {
  expect(
    failures(
      [
        { order: "pending_approval" },
        { order: "pending_approval", reason: "SPEND_OVER_LIMIT" },
        { maxOrders: 1 },
      ],
      [pending],
    ),
  ).toEqual([null, null, null]);
  expect(
    failures(
      [
        { order: "placed" },
        { order: "pending_approval", reason: "NEW_PRODUCT" },
        { order: "none" },
        { maxOrders: 0 },
      ],
      [pending],
    ),
  ).toEqual([
    "got pending_approval [SPEND_OVER_LIMIT]",
    "got pending_approval [SPEND_OVER_LIMIT]",
    `order ${ORDER} is pending_approval`,
    "1 orders were created",
  ]);
  expect(failures([{ order: "placed" }, { order: "any" }, { order: "none" }], [])).toEqual([
    "no order was created",
    "no order was created",
    null,
  ]);
  expect(failures([{ order: "any" }], [pending])).toEqual([null]);
});

test("multi-product expectations reject split, missing, duplicate and wrong product lines", () => {
  const products = ["whole milk", "oat drink", "cooking cream"];
  const milk = { productId: "prod_0", name: products[0] ?? "" };
  const oat = { productId: "prod_1", name: products[1] ?? "" };
  const cream = { productId: "prod_2", name: products[2] ?? "" };
  const lines = [milk, oat, cream];
  const order = { ...pending, lines };
  const check = [{ orderProducts: products }];
  expect(failures(check, [order])).toEqual([null]);
  expect(failures(check, [order, { ...order, orderId: "another" }])[0]).toContain(
    "expected one order",
  );
  expect(failures(check, [{ ...order, lines: lines.slice(0, 2) }])[0]).toContain("did not match");
  expect(failures(check, [{ ...order, lines: [milk, milk, cream] }])[0]).toContain("did not match");
  expect(
    failures(check, [{ ...order, lines: [milk, oat, { productId: "other", name: "butter" }] }])[0],
  ).toContain("did not match");
});

test("accepted multi-product order preserves server-rounded quantities and Monday delivery", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const deadline = "2026-11-16";
  const quantity = { value: 10, unit: "LTR" };
  const check = [
    { orderContents: { products: ["milk", "oat", "cream"], quantity, weekday: "Monday" as const } },
  ];
  const makeLine = (productId: string, name: string, packs: number, size: number) => ({
    productId,
    name,
    quantity: { value: packs, unit: "ST" },
    perSalesUnit: { value: size, unit: "LTR" },
    requestedDate: deadline,
    deliveryDate: deadline,
  });
  const milk = makeLine("a", "milk", 10, 1);
  const lines = [milk, makeLine("b", "oat", 7, 1.5), makeLine("c", "cream", 10, 1)];
  const candidates = lines.map((line) => ({
    productId: line.productId,
    orderQuantity: line.quantity,
    equals: { value: line.quantity.value * line.perSalesUnit.value, unit: "LTR" },
  }));
  const search = {
    tool: "find_products",
    args: { quantity, deliverBy: deadline },
    text: JSON.stringify({ results: ["summary", { candidates }] }),
    error: null,
  };
  const searched: Trace = { ...trace, calls: [...trace.calls, search] };
  const order = { ...pending, lines };
  const result = (orders: OrderState[], actualTrace = searched) =>
    judge(check, actualTrace, orders, [], now)[1]?.failure;
  expect(result([order])).toBeNull();
  expect(result([{ ...order, status: "placed" }])).toBeNull();
  expect(result([{ ...order, status: "rejected" }])).toContain("rejected");
  expect(result([{ ...order, lines: [makeLine("a", "milk", 1, 1), ...lines.slice(1)] }])).toContain(
    "did not match",
  );
  expect(
    result([
      { ...order, lines: [{ ...milk, quantity: { value: 10, unit: "KGM" } }, ...lines.slice(1)] },
    ]),
  ).toContain("did not match");
  expect(
    result([
      {
        ...order,
        lines: [{ ...milk, perSalesUnit: { value: 1, unit: "KGM" } }, ...lines.slice(1)],
      },
    ]),
  ).toContain("did not match");
  expect(
    result([{ ...order, lines: [{ ...milk, deliveryDate: "2026-11-17" }, ...lines.slice(1)] }]),
  ).toContain("did not match");
  expect(
    result([{ ...order, lines: [{ ...milk, requestedDate: "2026-11-23" }, ...lines.slice(1)] }]),
  ).toContain("did not match");
  expect(
    result([order], {
      ...searched,
      calls: [...searched.calls, { ...search, args: { ...search.args, deliverBy: "2026-11-23" } }],
    }),
  ).toContain("search requests");
});

test("call counts and batched quotes inspect the actual trace", () => {
  const quote = { tool: "quote_offers", args: { lines: [{}, {}, {}] }, error: null, text: "" };
  const batched = { ...trace, calls: [...trace.calls, quote] };
  const checks = [{ callCount: { tool: "place_order", count: 1 } }, { quoteLines: 3 }];
  expect(
    judge(checks, batched, [])
      .slice(1)
      .map((v) => v.failure),
  ).toEqual([null, null]);
  expect(
    judge(
      checks,
      {
        ...trace,
        calls: [
          ...trace.calls,
          { ...quote, args: { lines: Array.from({ length: 9 }, () => ({})) } },
        ],
      },
      [],
    )
      .slice(1)
      .map((v) => v.failure),
  ).toEqual([null, null]);
  expect(
    judge(checks, { ...batched, calls: [...batched.calls, quote] }, []).slice(1)[1]?.failure,
  ).not.toBeNull();
  expect(
    judge(
      checks,
      { ...trace, calls: [...trace.calls, { ...quote, args: { lines: [{}] } }] },
      [],
    ).slice(1)[1]?.failure,
  ).not.toBeNull();
  expect(
    judge([{ callCount: { tool: "place_order", count: 2 } }], batched, [])[1]?.failure,
  ).not.toBeNull();
});

const first = (t: Trace, problems: string[] = []) => judge([], t, [], problems)[0]?.failure;

test("every scenario fails when a step did not run or the agent gave no reply", () => {
  expect(first(trace)).toBeNull();
  expect(first({ turns: [], calls: [], reply: "" })).toBe("the agent gave no reply");
  expect(first(readTrace(chat(TOKEN, "Error: the model response was incomplete")))).toBe(
    "1 tool call(s) got no result from the host",
  );
  expect(first(trace, ['no "Approve order" button in a view', "no dialog to confirm"])).toBe(
    'no "Approve order" button in a view; no dialog to confirm',
  );
});

test("the host's MCP URL must be the server under test", () => {
  const api = "http://127.0.0.1:3000";
  expect(sameServer("http://host.docker.internal:3000/mcp", api)).toBe(true);
  expect(sameServer("http://localhost:3000/mcp", api)).toBe(true);
  expect(sameServer("http://host.docker.internal:3001/mcp", api)).toBe(false);
  expect(sameServer("http://other-machine:3000/mcp", api)).toBe(false);
  expect(sameServer("http://127.0.0.1:3000/other", api)).toBe(false);
  expect(sameServer("https://demo.example/mcp", "https://demo.example")).toBe(true);
});

test("equal call lines in a row are counted once", () => {
  const ok = { tool: "get_offers", args: {}, error: null, text: "" };
  const calls = [ok, ok, ok, { ...ok, tool: "place_order" }];
  expect(describeCalls(calls)).toEqual(["get_offers ok (3 times)", "place_order ok"]);
  expect(describeCalls(calls, 2, 2)).toEqual(["get_offers ok", "place_order ok"]);
});

test("the shipped scenario file is valid", async () => {
  const scenarios = parseScenarios(
    await Bun.file(`${import.meta.dir}/../hosts/openwebui/scenarios.json`).text(),
  );
  expect(scenarios.length).toBeGreaterThan(0);
  expect(new Set(scenarios.map((s) => s.name)).size).toBe(scenarios.length);
});

const scenarioFile = (extra: object) =>
  JSON.stringify([{ name: "a", steps: [{ say: "x" }], expect: [], ...extra }]);

test("refuses a scenario with an unknown step or expectation", () => {
  expect(() => parseScenarios(scenarioFile({ steps: [{ shout: "x" }] }))).toThrow("Unknown step");
  expect(() => parseScenarios(scenarioFile({ expect: [{ order: "maybe" }] }))).toThrow(
    "Unknown expectation",
  );
  expect(() => parseScenarios(scenarioFile({ steps: [] }))).toThrow("has no steps");
  expect(() => parseScenarios("[]")).toThrow("must be a list");
});

test("parses multi-product expectations and rejects malformed checks", () => {
  const checks: Expectation[] = [
    { callCount: { tool: "place_order", count: 1 } },
    { quoteLines: 3 },
    { orderProducts: ["milk", "oat", "cream"] },
    {
      orderContents: {
        products: ["milk"],
        quantity: { value: 10, unit: "LTR" },
        weekday: "Monday",
      },
    },
  ];
  expect(parseScenarios(scenarioFile({ expect: checks }))[0]?.expect).toEqual(checks);
  for (const check of [
    { callCount: { tool: "place_order", count: -1 } },
    { callCount: { tool: "place_order", count: 1.5 } },
    { quoteLines: 0 },
    { orderProducts: [] },
    { orderProducts: ["["] },
    { orderProducts: [1] },
    { orderContents: { products: ["["], quantity: { value: 10, unit: "LTR" }, weekday: "Monday" } },
    {
      orderContents: { products: ["milk"], quantity: { value: 0, unit: "LTR" }, weekday: "Monday" },
    },
    {
      orderContents: {
        products: ["milk"],
        quantity: { value: 10, unit: "LTR" },
        weekday: "Tuesday",
      },
    },
  ]) {
    expect(() => parseScenarios(scenarioFile({ expect: [check] }))).toThrow("Unknown expectation");
  }
});
