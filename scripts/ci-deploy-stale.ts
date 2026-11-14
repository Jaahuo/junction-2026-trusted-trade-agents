import { $ } from "bun";
import { appendFile } from "node:fs/promises";

/** The ids of the deploy workflow runs later than this run, or undefined when the list omits this run. */
export const laterRuns = (runs: unknown, own: number): number[] | undefined => {
  if (!Array.isArray(runs)) throw new Error("Invalid workflow run list");
  const decoded = runs.map((run: unknown) => {
    if (
      !run ||
      typeof run !== "object" ||
      !("id" in run) ||
      typeof run.id !== "number" ||
      !("run_number" in run) ||
      typeof run.run_number !== "number"
    )
      throw new Error("Invalid workflow run");
    return { id: run.id, number: run.run_number };
  });
  if (!decoded.some((run) => run.number === own)) return undefined;
  return decoded.filter((run) => run.number > own).map((run) => run.id);
};

const DEPLOY_STEP = "Deploy verified digest";

/**
 * Whether any attempt of a run may have changed the host. Only a deploy job that completed with
 * its deploy step skipped or absent proves it did not; a full page may hide an attempt, so it counts.
 */
export const reachedDeploy = (jobs: unknown): boolean => {
  if (!Array.isArray(jobs)) throw new Error("Invalid workflow job list");
  if (jobs.length >= 100) return true;
  return jobs.some((job: unknown) => {
    if (!job || typeof job !== "object" || !("name" in job) || !("status" in job))
      throw new Error("Invalid workflow job");
    if (job.name !== "deploy") return false;
    if (job.status !== "completed") return true;
    const steps: unknown = "steps" in job ? job.steps : undefined;
    if (!Array.isArray(steps)) return false;
    return steps.some(
      (step: unknown) =>
        step !== null &&
        typeof step === "object" &&
        "name" in step &&
        step.name === DEPLOY_STEP &&
        !("conclusion" in step && step.conclusion === "skipped"),
    );
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

const stale = async (repo: string, own: number): Promise<string | undefined> => {
  const later = laterRuns(await listRuns(repo), own);
  if (!later) return `run ${own} is too old to compare with later deploys`;
  for (const id of later) {
    const jobs = await api(
      `repos/${repo}/actions/runs/${id}/jobs?filter=all&per_page=100`,
      ".jobs",
    );
    if (reachedDeploy(jobs)) return `a later main pipeline reached its deploy before run ${own}`;
  }
  return undefined;
};

if (import.meta.main) {
  const own = Number(process.env["GITHUB_RUN_NUMBER"]);
  const repo = process.env["REPO"];
  if (!Number.isSafeInteger(own) || !repo)
    throw new Error("GITHUB_RUN_NUMBER and REPO are required");
  const reason = await stale(repo, own);
  const summary = reason ? `Skipped: ${reason}.` : `Run ${own} deploys: it is the newest.`;
  await appendFile(process.env["GITHUB_OUTPUT"] ?? "/dev/null", `deploy=${!reason}\n`);
  await appendFile(process.env["GITHUB_STEP_SUMMARY"] ?? "/dev/null", `${summary}\n`);
  console.log(summary);
}
