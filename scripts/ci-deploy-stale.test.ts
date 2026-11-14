import { expect, test } from "bun:test";
import { laterRuns, reachedDeploy } from "./ci-deploy-stale.ts";

const run = (run_number: number) => ({ id: run_number * 10, run_number });
const job = (name: string, status: string, step?: string | null) => ({
  name,
  status,
  steps: step === undefined ? [] : [{ name: "Deploy verified digest", conclusion: step }],
});

test("only later runs are listed for the stale check", () => {
  expect(laterRuns([run(7), run(6)], 7)).toEqual([]);
  expect(laterRuns([run(9), run(8), run(7), run(6)], 7)).toEqual([90, 80]);
});

test("a run that the fetched history no longer lists is reported, so it does not deploy", () => {
  expect(laterRuns([run(400), run(399)], 7)).toBeUndefined();
});

test("the deploy step name matches the workflow", async () => {
  const workflow = await Bun.file(`${import.meta.dir}/../.github/workflows/deploy.yml`).text();
  expect(workflow).toContain("      - name: Deploy verified digest\n        id: deploy\n");
});

test("every deploy job state blocks an older deploy unless its deploy step never started", () => {
  const builds = [job("api", "completed"), job("chat", "completed")];
  for (const status of ["queued", "in_progress", "waiting", "pending", "completed"])
    for (const step of [undefined, null, "success", "failure", "cancelled", "skipped"]) {
      const safe = status === "completed" && (step === undefined || step === "skipped");
      for (const smoke of [[], [job("smoke-api", "completed")]])
        expect(
          reachedDeploy([...builds, job("deploy", status, step), ...smoke]),
          `${status} ${step}`,
        ).toBe(!safe);
    }
});

test("a run without a deploy job does not block an older deploy", () => {
  expect(reachedDeploy([])).toBe(false);
  expect(reachedDeploy([job("api", "in_progress"), job("chat", "completed")])).toBe(false);
});

test("a deploy in any attempt blocks, wherever it is in the list", () => {
  const failedRerun = [job("api", "completed"), job("deploy", "completed", "skipped")];
  const deployed = [job("api", "completed"), job("deploy", "completed", "success")];
  expect(reachedDeploy([...deployed, ...failedRerun])).toBe(true);
  expect(reachedDeploy([...failedRerun, ...deployed])).toBe(true);
  expect(reachedDeploy([...failedRerun, ...failedRerun])).toBe(false);
});

test("a full page of jobs blocks, because it may hide a deploy", () => {
  expect(reachedDeploy(Array.from({ length: 100 }, () => job("api", "completed")))).toBe(true);
  expect(reachedDeploy(Array.from({ length: 99 }, () => job("api", "completed")))).toBe(false);
});

test("unreadable run and job lists fail closed", () => {
  expect(() => laterRuns({}, 7)).toThrow();
  expect(() => laterRuns([{ id: 1, run_number: "6" }], 7)).toThrow();
  expect(() => laterRuns([{ run_number: 6 }], 7)).toThrow();
  expect(() => reachedDeploy({})).toThrow();
  expect(() => reachedDeploy([{ name: "deploy" }])).toThrow();
});
