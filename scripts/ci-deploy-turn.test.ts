import { expect, test } from "bun:test";
import { deployTurn, reachedDeploy } from "./ci-deploy-turn.ts";

const run = (run_number: number, status: string) => ({ id: run_number * 10, run_number, status });
const job = (name: string, status: string, conclusion: string | null = null) => ({
  name,
  status,
  conclusion,
});

test("a run does not wait when every earlier run has completed", () => {
  expect(deployTurn([run(7, "in_progress")], 7)).toEqual({ wait: false, later: [] });
  expect(
    deployTurn([run(7, "in_progress"), run(6, "completed"), run(5, "completed")], 7).wait,
  ).toBe(false);
});

test("a run waits while any earlier run is queued, waiting or in progress", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending", "requested"])
    expect(deployTurn([run(7, "in_progress"), run(6, "completed"), run(5, status)], 7).wait).toBe(
      true,
    );
});

test("a later run does not make a run wait, and is listed for the stale check", () => {
  expect(
    deployTurn([run(9, "completed"), run(8, "in_progress"), run(7, "in_progress")], 7),
  ).toEqual({ wait: false, later: [90, 80] });
});

test("a later run counts as deployed once its deploy job is queued, running or successful", () => {
  const builds = [job("api", "completed", "success"), job("chat", "completed", "success")];
  expect(reachedDeploy([...builds, job("deploy", "queued")])).toBe(true);
  expect(reachedDeploy([...builds, job("deploy", "in_progress")])).toBe(true);
  expect(reachedDeploy([...builds, job("deploy", "completed", "success")])).toBe(true);
  expect(
    reachedDeploy([
      ...builds,
      job("deploy", "completed", "success"),
      job("smoke-api", "completed", "failure"),
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
  expect(() => deployTurn({}, 7)).toThrow();
  expect(() => deployTurn([{ id: 1, run_number: "6", status: "completed" }], 7)).toThrow();
  expect(() => deployTurn([{ run_number: 6, status: "completed" }], 7)).toThrow();
  expect(() => reachedDeploy({})).toThrow();
  expect(() => reachedDeploy([{ name: "deploy" }])).toThrow();
});
