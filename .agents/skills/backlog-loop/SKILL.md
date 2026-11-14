---
name: backlog-loop
description: Drain the issue backlog autonomously, one ready issue per iteration - pick, claim, build, self-verify, ship, merge, repeat. Use for /backlog-loop, "work the backlog", or running many agents on the queue at once.
---

# Backlog loop

You are one of many agents, on many machines, draining the same backlog.
Each iteration takes one issue from **ready** to **merged**, with your own evidence, then starts again.
Running this skill is the person's instruction to take ready issues: `claim` assigns each one to the GitHub user you run as (AGENTS.md).

`bun scripts/backlog.ts --help` is the source of truth for what **ready** means and how the claim works.
In short: the claim is the remote branch `task/<n>`, created through the GitHub refs API, which refuses a second create, so exactly one agent owns an issue.

## Iteration

Work from the primary checkout until step 3, then inside the task worktree.

1. **Pick.** Run `git pull --ff-only origin main`, then `bun scripts/backlog.ts next`. Done when you hold the first issue number in the list. An empty list ends the loop: report and stop.
2. **Claim.** Run `bun scripts/backlog.ts claim <n> --agent "<model> on <machine>"`. Exit code 3 means another agent holds it or it stopped being ready: take the next number from step 1. Done when the command prints `Claimed #<n>`.
3. **Start.** Run `bun scripts/task.ts start <n>` and work in the printed worktree. Done when you are on branch `task/<n>` in that worktree.
4. **Understand.** Read the whole issue with comments: Goal, Owns, Depends on, Acceptance, Definitions. Read the specs and the code it names. Use the repository skill that covers the work (`add-feature`, `new-context`, `sponsors`, `elysiajs`). Done when you can name, for every Acceptance item, the test or check that will prove it.
5. **Build** inside the Owns paths, test-first: each Acceptance case becomes a test next to the code, red before the change and green after it. A path outside Owns needs a reason in the PR; an optional contract field also needs the SPEC update (team rules R-05, R-08).
6. **Verify** as the only verifier this issue gets before merge. Done when every Acceptance item has evidence you produced:
   - `bun run gate` exits 0.
   - The real changed flow runs: `bun run dev`, then the route, the smoke scenario (`bun scripts/demo-smoke.ts --scenario <n>`) or the screen in a browser with the console clean and a screenshot.
   - Live wholesaler calls are targeted and counted (R-22); test fixtures use invented products (R-23).
7. **Ship** with the issue's `risk:` label as `--risk`, following [ship](../ship/SKILL.md) and the evidence table in [workflow](../../../docs/workflow.md#risk-and-evidence):
   - `ordinary`: `bun run ship --risk ordinary`, wait for `gh pr checks <pr> --watch`, then `bun run ship --risk ordinary --merge`.
   - `impact`: get an **independent review** before merge. Spawn a fresh read-only reviewer, a different model family when available, and give it the issue, the diff and the claims to refute, not your conclusions. Fix each finding, review the new head again, write the review JSON and run `bun run ship --risk impact --review-file <file>`, then CI, then `--merge`.
   - A PR that changes `packages/contract` or `docs/specs.md` waits for the contract owner (R-08): add them with `gh pr edit <pr> --add-reviewer <login>`, comment what they must check, and go to step 9 without merging.
   - When `ship` says the branch is behind main: `git merge origin/main`, gate, ship again; an impact PR needs its review on the new head.
8. **Finish.** From the primary checkout: `git pull --ff-only origin main`, then the `bun run task finish <n> --pr <pr>` that ship printed. Done when the issue is closed and on Done.
9. **Loop** back to step 1.

## When you cannot finish

A claim never goes silent. When an Acceptance item needs a person (a decision, a mentor answer, a credential, a human approval) or an upstream fix you cannot make:

- No commits pushed yet: `bun scripts/backlog.ts release <n> --reason "<what is done, what blocks, what the person must decide>"`.
- Work pushed: open a draft PR with what works, add the `blocked` label to the issue and comment the same reason in SBAR form.

Then continue with step 1. Report every released or blocked issue at the end.

## Rules for parallel agents

- One issue per agent at a time; one worktree per issue.
- Touch only your own `task/<n>` branch and worktree. Never reset, rebase or push another agent's branch; never force-push or skip hooks.
- Monitor every CI run, review and merge you start until it finishes.

## Report

When the loop stops, report one row per issue: issue, PR, risk, result (merged, waiting for review, released, blocked) and the evidence or blocker.
