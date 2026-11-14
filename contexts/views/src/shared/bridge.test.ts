import { expect, test } from "bun:test";
import { fixtures, type Order } from "@app/contract";
import {
  callAction,
  type Fetch,
  type Host,
  hostSource,
  loadView,
  plainPageUrl,
  plainSource,
  viewEntry,
} from "./bridge.ts";

const baseUrl = "http://trade.test";
const order: Order = { ...fixtures.order, lines: [], status: "placed", approvalUrl: null };
const mandate = fixtures.storedMandate;

/** A fake MCP Apps host: records server-tool calls and delivers one tool result. */
function fakeHost(answer: Awaited<ReturnType<Host["callServerTool"]>>, accepts = true) {
  const calls: Parameters<Host["callServerTool"]>[0][] = [];
  const messages: string[] = [];
  const contexts: string[] = [];
  const listeners: ((structuredContent: unknown) => void)[] = [];
  const host: Host = {
    onToolResult: (listener) => listeners.push(listener),
    callServerTool: async (request) => {
      calls.push(request);
      return answer;
    },
    sendMessage: async (text) => {
      messages.push(text);
      return accepts;
    },
    updateModelContext: async (text) => {
      contexts.push(text);
    },
  };
  const deliver = (value: unknown) => {
    for (const listener of listeners) listener(value);
  };
  return { host, calls, messages, contexts, deliver };
}

/** A fake fetch: records each request and answers with one JSON body. */
function fakeFetch(body: unknown, statusCode = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json(body, { status: statusCode });
  };
  return { fetch, requests };
}

test("host mode passes structuredContent parsed with TOOL_OUTPUT", async () => {
  const { host, deliver } = fakeHost({});
  const state = loadView(viewEntry("order-timeline"), hostSource(host));
  deliver(order);
  expect(await state).toEqual({ kind: "done", data: order });

  const list = fakeHost({});
  const pending = loadView(viewEntry("approval-card"), hostSource(list.host));
  list.deliver({ orders: [] });
  expect(await pending).toEqual({ kind: "empty" });
});

test("plain mode loads plainLoad over REST with no token", async () => {
  const { fetch, requests } = fakeFetch(order);
  const source = plainSource("order-timeline", {
    fetch,
    baseUrl,
    query: new URLSearchParams({ order: "ord_test_1" }),
  });
  expect(await loadView(viewEntry("order-timeline"), source)).toEqual({
    kind: "done",
    data: order,
  });
  expect(requests).toEqual([{ url: `${baseUrl}/api/orders/ord_test_1`, init: { method: "GET" } }]);
  expect(JSON.stringify(requests)).not.toMatch(/authorization|bearer|token/i);
});

test("a failed parse gives the error state", async () => {
  const { host, deliver } = fakeHost({});
  const state = loadView(viewEntry("order-timeline"), hostSource(host));
  deliver({ error: { code: "NOT_FOUND", message: "No order." } });
  expect(await state).toMatchObject({ kind: "error", plainUrl: null });

  const { fetch } = fakeFetch({ ...mandate, status: "unknown" });
  const plain = plainSource("mandate-settings", { fetch, baseUrl, query: new URLSearchParams() });
  expect(await loadView(viewEntry("mandate-settings"), plain)).toMatchObject({ kind: "error" });
});

test("callAction maps to the server-tool call in host mode and to the ROUTES entry in plain mode", async () => {
  const args = { mandateId: "mnd_test_1" };
  const { host, calls } = fakeHost({ structuredContent: mandate });
  expect(await callAction(hostSource(host), "revoke_mandate", args, null)).toEqual({
    kind: "done",
    data: mandate,
  });
  expect(calls).toEqual([{ name: "revoke_mandate", arguments: args }]);

  const { fetch, requests } = fakeFetch(mandate);
  const plain = plainSource("mandate-settings", { fetch, baseUrl, query: new URLSearchParams() });
  expect(await callAction(plain, "revoke_mandate", args, null)).toEqual({
    kind: "done",
    data: mandate,
  });
  expect(requests).toEqual([
    {
      url: `${baseUrl}/api/mandates/mnd_test_1/revoke`,
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    },
  ]);
});

test("a failed action call gives the error state with the plain-page link", async () => {
  const plainUrl = plainPageUrl("mandate-settings", baseUrl);
  expect(plainUrl).toBe(`${baseUrl}/views/mandate-settings`);
  const args = { mandateId: "mnd_test_1" };

  const { host } = fakeHost({ isError: true, structuredContent: fixtures.errorEnvelope });
  expect(await callAction(hostSource(host), "revoke_mandate", args, plainUrl)).toMatchObject({
    kind: "error",
    plainUrl,
  });

  const { fetch } = fakeFetch(fixtures.errorEnvelope, 409);
  const plain = plainSource("mandate-settings", { fetch, baseUrl, query: new URLSearchParams() });
  expect(await callAction(plain, "revoke_mandate", args, plainUrl)).toMatchObject({
    kind: "error",
    plainUrl,
  });
});

test("host mode sends agent messages to the chat and fails when the host rejects one", async () => {
  const { host, messages } = fakeHost({});
  await hostSource(host).message?.("About the order: order less of each");
  expect(messages).toEqual(["About the order: order less of each"]);

  const rejecting = fakeHost({}, false);
  expect(hostSource(rejecting.host).message?.("Hello")).rejects.toThrow("did not take");
});

test("plain mode has no chat to message", () => {
  const source = plainSource("order-timeline", {
    fetch: fakeFetch(order).fetch,
    baseUrl,
    query: new URLSearchParams(),
  });
  expect(source.message).toBeUndefined();
});

test("host mode tells the model about a decision without a chat message", async () => {
  const { host, messages, contexts } = fakeHost({});
  await hostSource(host).context?.("The approver rejected order ord_test_1.");
  expect(contexts).toEqual(["The approver rejected order ord_test_1."]);
  expect(messages).toEqual([]);
});
