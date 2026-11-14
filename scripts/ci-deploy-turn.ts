import { $ } from "bun";
import { appendFile } from "node:fs/promises";

type Turn = "wait" | "deploy" | "stale";

/** Decides this run's turn from the deploy workflow's runs on main, as the REST API lists them. */
export const deployTurn = (runs: unknown, own: number): Turn => {
  if (!Array.isArray(runs)) throw new Error("Invalid workflow run list");
  let turn: Turn = "deploy";
  for (const run of runs) {
    if (
      !run ||
      typeof run !== "object" ||
      !("run_number" in run) ||
      typeof run.run_number !== "number" ||
      !("status" in run) ||
      typeof run.status !== "string"
    )
      throw new Error("Invalid workflow run");
    if (run.run_number > own && "conclusion" in run && run.conclusion === "success") return "stale";
    if (run.run_number < own && run.status !== "completed") turn = "wait";
  }
  return turn;
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
  const path = `repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&per_page=100`;
  for (let failures = 0, waited = false; ;) {
    const result = await $`gh api ${path} --jq .workflow_runs`.nothrow().quiet();
    if (result.exitCode !== 0) {
      if (++failures === 5)
        throw new Error(`Could not list deploy runs: ${result.stderr.toString()}`);
    } else {
      failures = 0;
      const turn = deployTurn(JSON.parse(result.stdout.toString()), own);
      if (turn === "deploy") {
        await report(true, `Run ${own} deploys: every earlier main pipeline has finished.`);
        break;
      }
      if (turn === "stale") {
        await report(false, `Skipped: a later main pipeline deployed before run ${own}.`);
        break;
      }
      if (!waited) console.log("Waiting for earlier main pipelines to finish...");
      waited = true;
    }
    await Bun.sleep(10_000);
  }
}
