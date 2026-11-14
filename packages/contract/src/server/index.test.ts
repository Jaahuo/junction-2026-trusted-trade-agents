import { expect, test } from "bun:test";
import { ok } from "@app/kernel";
import { DEMO_ACCOUNT } from "../index.ts";
import { principalOf } from "./index.ts";

test("principalOf(new Headers()) returns ok(DEMO_ACCOUNT)", async () => {
  expect(await principalOf(new Headers())).toEqual(ok(DEMO_ACCOUNT));
});
