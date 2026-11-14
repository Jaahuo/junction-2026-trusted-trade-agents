import { expect, test } from "bun:test";
import { laterRuns, reachedDeploy } from "./ci-deploy-stale.ts";

const run = (run_number: number) => ({ id: run_number * 10, run_number });
const job = (name: string, status: string, conclusion: string | null = null) => ({
  name,
  status,
  conclusion,
});

test("only later runs are listed for the stale check", () => {
  expect(laterRuns([run(7), run(6)], 7)).toEqual([]);
  expect(laterRuns([run(9), run(8), run(7), run(6)], 7)).toEqual([90, 80]);
});

test("a run that the fetched history no longer lists is reported, so it does not deploy", () => {
  expect(laterRuns([run(400), run(399)], 7)).toBeUndefined();
});

test("a later run counts as deployed once its deploy job is queued, running or successful", () => {
  const builds = [job("api", "completed", "success"), job("chat", "completed", "success")];
  expect(reachedDeploy([...builds, job("deploy", "queued")])).toBe(true);
  expect(reachedDeploy([...builds, job("deploy", "in_progress")])).toBe(true);
  expect(
    reachedDeploy([
      ...builds,
      job("deploy", "completed", "success"),
      job("smoke-api", "completed", "failure"),
    ]),
  ).toBe(true);
});

test("a deploy in an earlier attempt still counts after a failed re-run", () => {
  expect(
    reachedDeploy([
      job("api", "completed", "success"),
      job("deploy", "completed", "success"),
      job("api", "completed", "failure"),
      job("deploy", "completed", "skipped"),
    ]),
  ).toBe(true);
});

test("a later run that never deployed does not block an earlier run", () => {
  expect(reachedDeploy([job("api", "in_progress"), job("chat", "completed", "success")])).toBe(
    false,
  );
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"])
    expect(reachedDeploy([job("deploy", "completed", conclusion)])).toBe(false);
});

test("unreadable run and job lists fail closed", () => {
  expect(() => laterRuns({}, 7)).toThrow();
  expect(() => laterRuns([{ id: 1, run_number: "6" }], 7)).toThrow();
  expect(() => laterRuns([{ run_number: 6 }], 7)).toThrow();
  expect(() => reachedDeploy({})).toThrow();
  expect(() => reachedDeploy([{ name: "deploy" }])).toThrow();
});
