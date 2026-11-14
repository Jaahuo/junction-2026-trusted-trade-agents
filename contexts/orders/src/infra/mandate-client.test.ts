import { expect, test } from "bun:test";
import { DEMO_ACCOUNT, fixtures } from "@app/contract";
import { mandateClient } from "./mandate-client.ts";

const answering = (status: number, body: unknown) =>
  mandateClient("http://mandates.test/api", {
    fetcher: Object.assign(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      { preconnect: fetch.preconnect },
    ),
  });

test("the mandates route's own NOT_FOUND envelope means no current mandate", async () => {
  const client = answering(404, { error: { code: "NOT_FOUND", message: "No current mandate." } });
  expect(await client.current(DEMO_ACCOUNT.agentId)).toEqual({ ok: true, value: null });
});

test("a 404 without the envelope, a 500 or a body that fails the schema is an upstream failure", async () => {
  for (const client of [
    answering(404, { message: "Not Found" }),
    answering(500, { error: { code: "NOT_FOUND", message: "proxy" } }),
    answering(200, { mandate: { not: "a mandate" } }),
  ]) {
    expect(await client.current(DEMO_ACCOUNT.agentId)).toEqual({
      ok: false,
      error: "UPSTREAM_FAILED",
    });
  }
});

test("the current mandate is returned for its own agent and counts as none for another agent", async () => {
  const client = answering(200, fixtures.storedMandate);
  const own = await client.current(fixtures.storedMandate.mandate.agent);
  expect(own).toEqual({ ok: true, value: fixtures.storedMandate.mandate });
  expect(await client.current("agent_other")).toEqual({ ok: true, value: null });
});
