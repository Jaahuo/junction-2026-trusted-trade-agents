import { expect, test } from "bun:test";
import { ErrorEnvelopeSchema } from "@app/contract";
import { context, rootRoutes } from "./index.ts";
import { skillRoutes } from "./skill.ts";

const get = (path: string) => skillRoutes().handle(new Request(`http://localhost${path}`));
const base = "/skills/trusted-trade-ordering";

const expectFile = async (name: string) => {
  const response = await get(`${base}/${name}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("content-disposition")).toBe(`inline; filename="${name}"`);
  const expected = new Uint8Array(
    await Bun.file(
      `${import.meta.dir}/../../../../skills/trusted-trade-ordering/${name}`,
    ).arrayBuffer(),
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
};

test("GET SKILL.md returns the file", () => expectFile("SKILL.md"));

test("GET reason-codes.md returns the file", () => expectFile("reason-codes.md"));

test("unknown file returns 404", async () => {
  for (const name of ["package.json", "..%2F..%2Fpackage.json", "skill.md"]) {
    const response = await get(`${base}/${name}`);
    expect(response.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe("NOT_FOUND");
  }
});

test("the discovery context root serves the skill files", async () => {
  expect(context.root).toBe(rootRoutes);
  const response = await rootRoutes().handle(new Request(`http://localhost${base}/SKILL.md`));
  expect(response.status).toBe(200);
});
