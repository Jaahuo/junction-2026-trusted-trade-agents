import { expect, test } from "bun:test";
import { deployTurn } from "./ci-deploy-turn.ts";

const run = (run_number: number, status: string, conclusion: string | null = null) => ({
  run_number,
  status,
  conclusion,
});

test("a run deploys when every earlier run has completed, whatever its conclusion", () => {
  expect(deployTurn([run(7, "in_progress")], 7)).toBe("deploy");
  expect(
    deployTurn(
      [run(7, "in_progress"), run(6, "completed", "failure"), run(5, "completed", "cancelled")],
      7,
    ),
  ).toBe("deploy");
});

test("a run waits while any earlier run is queued or in progress", () => {
  expect(deployTurn([run(7, "in_progress"), run(6, "in_progress")], 7)).toBe("wait");
  expect(
    deployTurn([run(7, "in_progress"), run(6, "completed", "success"), run(5, "queued")], 7),
  ).toBe("wait");
});

test("a later run that is still building does not hold back an earlier run", () => {
  expect(deployTurn([run(8, "in_progress"), run(7, "in_progress")], 7)).toBe("deploy");
  expect(deployTurn([run(8, "completed", "failure"), run(7, "in_progress")], 7)).toBe("deploy");
});

test("a re-run never deploys over a later successful run", () => {
  expect(deployTurn([run(8, "completed", "success"), run(7, "in_progress")], 7)).toBe("stale");
  expect(
    deployTurn([run(8, "completed", "success"), run(7, "in_progress"), run(6, "in_progress")], 7),
  ).toBe("stale");
});

test("an unreadable run list fails closed", () => {
  expect(() => deployTurn({}, 7)).toThrow();
  expect(() => deployTurn([{ run_number: "6", status: "completed" }], 7)).toThrow();
  expect(() => deployTurn([{ run_number: 6 }], 7)).toThrow();
});
