import { expect, test } from "bun:test";
import { fixtures } from "@app/contract";
import { err, ok } from "@app/kernel";
import { notImplemented } from "@app/server-kit";
import { edenMandateSource } from "./mandate-client.ts";

const stored = fixtures.storedMandate;
const { standingConstraints: _dropped, ...withoutConstraints } = stored.mandate;

const json = (value: unknown) => ({ text: JSON.stringify(value), type: "application/json" });
const BODIES = {
  "valid stored mandate": json(stored),
  "empty object": json({}),
  "mandate missing standingConstraints": json({ ...stored, mandate: withoutConstraints }),
  "NOT_FOUND envelope": json({ error: { code: "NOT_FOUND", message: "no mandate" } }),
  "NOT_IMPLEMENTED envelope": json({ error: { code: "NOT_IMPLEMENTED", message: "not built" } }),
  "other-code envelope": json({ error: { code: "CONFLICT", message: "other" } }),
  "HTML string": { text: "<html><body>proxy error</body></html>", type: "text/html" },
  empty: { text: "", type: null },
};
const STATUSES = [200, 201, 204, 400, 404, 500, 501, 502, 503] as const;

const expected = (status: number, body: string) => {
  if ((status === 200 || status === 201) && body === "valid stored mandate") {
    const { mandateId, version, standingConstraints } = stored.mandate;
    return ok({ id: mandateId, version, standingConstraints });
  }
  if (status === 404 && body === "NOT_FOUND envelope") return ok(null);
  if (status === 501 && body === "NOT_IMPLEMENTED envelope") return ok(null);
  return err("UPSTREAM_FAILED");
};

const answering = (status: number, body: { text: string; type: string | null }) =>
  Object.assign(
    async () =>
      new Response(status === 204 || body.text === "" ? null : body.text, {
        status,
        headers: body.type === null ? {} : { "content-type": body.type },
      }),
    { preconnect: fetch.preconnect },
  );

test("the mandates response maps to a mandate, no mandate or UPSTREAM_FAILED for every status and body", async () => {
  const actual: Record<string, unknown> = {};
  const wanted: Record<string, unknown> = {};
  for (const status of STATUSES) {
    for (const [name, body] of Object.entries(BODIES)) {
      const key = `${status} ${name}`;
      const source = edenMandateSource(() => "http://localhost/api", answering(status, body));
      actual[key] = await source.current();
      wanted[key] = expected(status, name);
    }
  }
  expect(actual).toEqual(wanted);
});

test("a fetch that throws gives UPSTREAM_FAILED", async () => {
  const failing = Object.assign(
    async (): Promise<Response> => {
      throw new TypeError("connection refused");
    },
    { preconnect: fetch.preconnect },
  );
  expect(await edenMandateSource(() => "http://localhost/api", failing).current()).toEqual(
    err("UPSTREAM_FAILED"),
  );
});

test("the 501 body of the mandates stub gives no mandate", async () => {
  const stub = json(notImplemented("mandate"));
  expect(
    await edenMandateSource(() => "http://localhost/api", answering(501, stub)).current(),
  ).toEqual(ok(null));
});
