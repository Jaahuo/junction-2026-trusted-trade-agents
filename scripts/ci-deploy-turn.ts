import { $ } from "bun";
import { appendFile } from "node:fs/promises";

type Run = { id: number; number: number; completed: boolean };

const decodeRuns = (runs: unknown): Run[] => {
  if (!Array.isArray(runs)) throw new Error("Invalid workflow run list");
  return runs.map((run: unknown) => {
    if (
      !run ||
      typeof run !== "object" ||
      !("id" in run) ||
      typeof run.id !== "number" ||
      !("run_number" in run) ||
      typeof run.run_number !== "number" ||
      !("status" in run) ||
      typeof run.status !== "string"
    )
      throw new Error("Invalid workflow run");
    return { id: run.id, number: run.run_number, completed: run.status === "completed" };
  });
};

/** Splits the deploy workflow's runs on main into the earlier runs still active and the later runs. */
export const deployTurn = (
  runs: unknown,
  own: number,
): { listed: boolean; wait: boolean; later: number[] } => {
  const decoded = decodeRuns(runs);
  return {
    listed: decoded.some((run) => run.number === own),
    wait: decoded.some((run) => run.number < own && !run.completed),
    later: decoded.filter((run) => run.number > own).map((run) => run.id),
  };
};

/** Whether a run's deploy job is queued, running or successful, from the run's job list. */
export const reachedDeploy = (jobs: unknown): boolean => {
  if (!Array.isArray(jobs)) throw new Error("Invalid workflow job list");
  return jobs.some((job: unknown) => {
    if (!job || typeof job !== "object" || !("name" in job) || !("status" in job))
      throw new Error("Invalid workflow job");
    if (job.name !== "deploy") return false;
    return job.status !== "completed" || ("conclusion" in job && job.conclusion === "success");
  });
};

const api = async (path: string, filter: string): Promise<unknown> => {
  for (let attempt = 1; ; attempt++) {
    const result = await $`gh api ${path} --jq ${filter}`.nothrow().quiet();
    if (result.exitCode === 0) return JSON.parse(result.stdout.toString());
    if (attempt === 5) throw new Error(`gh api ${path} failed: ${result.stderr.toString()}`);
    await Bun.sleep(5000);
  }
};

const listRuns = async (repo: string): Promise<unknown[]> => {
  const runs: unknown[] = [];
  // Three pages cover 300 runs, far more than can start while one run is active.
  for (let page = 1; page <= 3; page++) {
    const batch = await api(
      `repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&per_page=100&page=${page}`,
      ".workflow_runs",
    );
    if (!Array.isArray(batch)) throw new Error("Invalid workflow run list");
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs;
};

const report = async (deploy: boolean, summary: string): Promise<void> => {
  await appendFile(process.env["GITHUB_OUTPUT"] ?? "/dev/null", `deploy=${deploy}\n`);
  await appendFile(process.env["GITHUB_STEP_SUMMARY"] ?? "/dev/null", `${summary}\n`);
  console.log(summary);
};

if (import.meta.main) {
  const own = Number(process.env["GITHUB_RUN_NUMBER"]);
  const repo = process.env["REPO"];
  if (!Number.isSafeInteger(own) || !repo)
    throw new Error("GITHUB_RUN_NUMBER and REPO are required");
  const wait = !process.argv.includes("--no-wait");
  for (let waited = false; ; waited = true) {
    const turn = deployTurn(await listRuns(repo), own);
    if (!turn.listed) {
      await report(false, `Skipped: run ${own} is too old to compare with later deploys.`);
      break;
    }
    let stale = false;
    for (const id of turn.later) {
      const jobs = await api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`, ".jobs");
      if (reachedDeploy(jobs)) stale = true;
      if (stale) break;
    }
    if (stale) {
      await report(false, `Skipped: a later main pipeline reached its deploy before run ${own}.`);
      break;
    }
    if (!wait || !turn.wait) {
      await report(true, `Run ${own} deploys: no later main pipeline has reached its deploy.`);
      break;
    }
    if (!waited) console.log("Waiting for earlier main pipelines to finish...");
    await Bun.sleep(10_000);
  }
}
