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

1. **Resume, then pick.** Run `git pull --ff-only origin main`. First finish your own **waiting** PRs: for each open PR from a `task/<n>` branch of an issue assigned to you, check whether the person it waits for approved its current head (`gh pr view <pr> --json reviews,headRefOid`). When they did, run `wt switch task/<n>` and continue at step 7 with that approval as the evidence; when not, leave it. Then run `bun scripts/backlog.ts next`. Done when you hold the first issue number in the list. An empty list ends the loop: report and stop.
2. **Claim.** Run `bun scripts/backlog.ts claim <n> --agent "<model> on <machine>"`. Exit code 3 means another agent holds it or it stopped being ready: take the next number from step 1. Done when the command prints `Claimed #<n>`.
3. **Start.** Run `bun scripts/task.ts start <n>` and work in the printed worktree. Done when you are on branch `task/<n>` in that worktree.
4. **Understand.** Read the whole issue with comments: Goal, Owns, Depends on, Acceptance, Definitions. Read the specs and the code it names. Use the repository skill that covers the work (`add-feature`, `new-context`, `sponsors`, `elysiajs`). Done when you can name, for every Acceptance item, the test or check that will prove it.
5. **Build** inside the Owns paths, test-first: each Acceptance case becomes a test next to the code, red before the change and green after it. The one exception is an optional contract field or export, together with its SPEC update (R-08). When the work needs any other path, R-05 applies: comment on the issue that owns that path, then treat the issue as one you cannot finish.
6. **Verify** as the only verifier this issue gets before merge. Done when every Acceptance item has evidence you produced:
   - `bun run gate` exits 0.
   - The real changed flow runs: `bun run dev`, then the route, the smoke scenario (`bun scripts/demo-smoke.ts --scenario <n>`) or the screen in a browser with the console clean and a screenshot.
   - Live wholesaler calls are targeted and counted (R-22); test fixtures use invented products (R-23).
7. **Ship** with the issue's `risk:` label as `--risk`, following [ship](../ship/SKILL.md) and the evidence table in [workflow](../../../docs/workflow.md#risk-and-evidence):
   - `ordinary`: `bun run ship --risk ordinary`, wait for `gh pr checks <pr> --watch`, then `bun run ship --risk ordinary --merge`.
   - `impact`: get an **independent review** before merge. Spawn a fresh read-only reviewer, a different model family when available, and give it the issue, the diff and the claims to refute, not your conclusions. Fix each finding, review the new head again, write the review JSON and run `bun run ship --risk impact --review-file <file>`, then CI, then `--merge`.
   - A PR that changes `packages/contract` or `docs/specs.md` needs the contract owner's approval of its current head (R-08). With that approval, merge as above. Without it, add them with `gh pr edit <pr> --add-reviewer <login>` and comment what they must check. The PR is now **waiting**: it keeps its claim, step 1 resumes it once approved, and you go to step 9 without merging.
   - When `ship` says the branch is behind main: `git merge origin/main`, gate, ship again; an impact PR needs its review on the new head.
8. **Finish.** From the primary checkout: `git pull --ff-only origin main`, then the `bun run task finish <n> --pr <pr>` that ship printed. Done when the issue is closed and on Done.
9. **Loop** back to step 1.

## When you cannot finish

A claim never goes silent. When an Acceptance item needs a person (a decision, a mentor answer, a credential, a human approval) or an upstream fix you cannot make:

- No commits pushed yet: `bun scripts/backlog.ts release <n> --blocked --reason "<what is done, what blocks, what the person must decide>"`. The `blocked` label keeps every agent off the issue until a person removes it.
- Work pushed: open a draft PR with what works, add the `blocked` label to the issue and comment the same reason in SBAR form.

Use `release` without `--blocked` only when the issue is fine but you must stop, so another agent can take it.

Then continue with step 1. Report every released or blocked issue at the end.

## Rules for parallel agents

- One issue in build per agent at a time; one worktree per issue. A waiting PR does not count.
- Touch only your own `task/<n>` branch and worktree. Never reset, rebase or push another agent's branch; never force-push or skip hooks.
- Monitor every CI run, review and merge you start until it finishes.

## Report

When the loop stops, report one row per issue: issue, PR, risk, result (merged, waiting, released, blocked) and the evidence or blocker.
