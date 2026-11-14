import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorEnvelopeSchema, VIEWS } from "@app/contract";
import { createRoot } from "./index.ts";

const dir = await mkdtemp(join(tmpdir(), "views-api-"));
const files = { dist: join(dir, "dist"), fixtures: join(dir, "fixtures") };
for (const { view } of VIEWS)
  await Bun.write(
    join(files.dist, `${view}.html`),
    `<html><head></head><body>${view}</body></html>`,
  );
await Bun.write(join(files.fixtures, "order-timeline", "done.json"), '{"note":"</script>"}');
afterAll(() => rm(dir, { recursive: true, force: true }));

const app = createRoot(files, () => "http://trade.test");
const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

const expectNotFound = async (response: Response) => {
  expect(response.status).toBe(404);
  expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe("NOT_FOUND");
};

test("each VIEWS entry is served as HTML with the base URL written in", async () => {
  for (const { view } of VIEWS) {
    const response = await get(`/views/${view}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(view);
    expect(html).toContain('<meta name="tt-base-url" content="http://trade.test">');
    expect(html).not.toContain("tt-harness");
  }
});

test("an unknown view gives the 404 error envelope", async () => {
  await expectNotFound(await get("/views/no-such-view"));
});

test("a view that is not built gives the 404 error envelope", async () => {
  const empty = createRoot({ ...files, dist: join(dir, "missing") }, () => "http://trade.test");
  await expectNotFound(await empty.handle(new Request("http://localhost/views/approval-card")));
});

test("the harness injects the fixture as the tool result, escaped for a script", async () => {
  const html = await (await get("/views/harness?view=order-timeline&state=done")).text();
  expect(html).toContain(
    String.raw`<script type="application/json" id="tt-harness">{"result":{"note":"</script>"}}</script>`,
  );
});

test("the harness loading state needs no fixture file", async () => {
  const html = await (await get("/views/harness?view=search-results&state=loading")).text();
  expect(html).toContain('{"state":"loading"}');
});

test("the harness rejects unknown views and fixtures, including paths", async () => {
  await expectNotFound(await get("/views/harness?view=no-such-view&state=done"));
  await expectNotFound(await get("/views/harness?view=order-timeline&state=missing"));
  await expectNotFound(await get("/views/harness?view=order-timeline&state=../../dist/x"));
  await expectNotFound(await get("/views/harness?state=done"));
});

test("the harness index frames every state of every view", async () => {
  const html = await (await get("/views/harness")).text();
  for (const { view } of VIEWS) expect(html).toContain(`view=${view}&amp;state=loading`);
  expect(html).toContain("view=order-timeline&amp;state=done");
});
