# Task and pull request workflow

Each candidate has its own GitHub Issues and private board. Issues are created unassigned. A person assigns a task owner, or an agent does so with `gh issue edit <n> --add-assignee <login>` when the person it works for tells it to take that issue or lane. One owner and one worktree are responsible for each independently committing task. Helpers receive disjoint writable paths and explicit interfaces; they do not independently commit, push, open PRs or merge. Coordinate shared files and tooling changes explicitly. A shared folder is not itself a risk classification.

1. Start the assigned issue: `bun scripts/task.ts start <issue>`. The command fetches `origin/main` before Worktrunk creates `task/<issue>` from that remote branch. It adds the issue to the uniquely linked project if needed and moves it to In progress. Navigate to the worktree with `wt switch task/<issue>`. The Worktrunk `pre-start` hook copies `.env` from the primary worktree into the new worktree when it has none. It never overwrites `.env` and skips `.env.local` and `.env.test.local`.
2. Record helper scopes and handoff: `bun scripts/task.ts handoff <issue> --scope <owner>:<path> --message <text>`. Repeat `--scope` as needed.
3. Once a dependency PR has merged, synchronize using `bun scripts/task.ts sync <issue> --depends-on <merged-PR>`. The merged commit, not a pre-squash head, is the dependency.
4. Inspect task state with `bun scripts/task.ts status <issue>`. The current authenticated user needs project access and scope for board updates. Do not rely on the repository Actions token as a Projects credential.
5. Integrate changes, run the applicable checks and gate at the integrated end, and smoke the real changed flow. Document actual results, limitations, risk and review evidence in the PR.
6. The owner runs `bun scripts/ship.ts --risk <risk>` to open or update a PR. The default does not merge. After required evidence and authorization, `bun scripts/ship.ts --risk <risk> --merge` requests the merge. After the merge, it runs step 7 for a `task/<issue>` branch and the worktree cleanup for any other branch. Never force-push or bypass hooks.
7. When the PR merged outside ship, run `bun run task finish <issue> --pr <merged-pr>`. It verifies the PR merged from `task/<issue>` into main and its merge commit is reachable from fetched `origin/main`, closes the issue if open, moves its board item to Done and cleans up the worktree. Ship adds `Closes #<issue>` to task-branch PR bodies while preserving existing closing links.

CI runs the full gate inside an isolated Linux PID and mount namespace. A system helper creates it, then drops to the runner's original user before executing repository code. This keeps protected host processes outside the cleanup tests without changing cleanup permissions or skipping tests.

## Agents draining the backlog

Many agents can work the backlog at once with the `backlog-loop` skill. `bun scripts/backlog.ts next` lists the issues an agent can finish start to end now; `--all` shows why the others wait. `bun scripts/backlog.ts claim <issue>` creates the remote branch `task/<issue>` through the GitHub refs API, which refuses an existing ref, so of two agents that claim at once exactly one wins and is assigned; the other exits 3 and picks the next issue. Unlike assignment, the claim is atomic across machines. An agent that cannot finish runs `bun scripts/backlog.ts release <issue> --reason <text>` when it pushed no work, or opens a draft PR and labels the issue `blocked`.

## Worktree cleanup after merge

The owner removes the task worktree once its PR merges. `ship --merge` and `task finish` stop current-user processes whose working directories are inside the target worktree before dropping its database. Other users' processes stay untouched. Cleanup sends TERM, then KILL to processes that remain. It reports each signal and keeps the worktree if discovery or termination fails. It then runs `wt remove` and deletes the local branch. Cleanup also keeps the worktree when the command runs inside it, when it has uncommitted changes, when its `HEAD` differs from the merged PR head, or when it is the main worktree. Then commit or discard that work, and clean up by hand as [local runtime](runtime.md) says. Ship runs inside the task worktree, so after a merge it prints the cleanup command. Move to the main checkout, update it with `git pull --ff-only origin main` so it has the current cleanup script, and run that command there. Remove an exploration worktree by hand when you finish with it.

## Fresh upstream for worktrees

Always fetch the upstream immediately before creating a worktree, including temporary exploration worktrees. Base it on the freshly fetched remote branch, not local `main`, an old task branch or a cached remote-tracking ref:

```sh
git fetch origin main
wt switch --create <branch> --base origin/main
```

If the fetch fails, stop creation rather than silently using stale state. For a different upstream, fetch that remote and branch and use its remote-tracking ref.

Before exploring an existing worktree, fetch upstream and compare `HEAD` with it using `git rev-list --left-right --count HEAD...origin/main`. Keep local work separate from claims about current upstream behavior. Use a new worktree from fetched upstream when exploration needs the current upstream code. Never reset or rebase another owner's work.

## Local check hooks

`bun install` runs `prepare` to install the Vite+ Git hook dispatcher in each clone. Run `bunx vp hooks status` to verify installation. If the dispatcher is missing, run `bunx vp hooks enable`. Hook scripts live in `.vite-hooks/`; do not commit the generated `.vite-hooks/_/` dispatcher.

Run `bun scripts/runtime.ts setup` before checks so route tests have the disposable local PostgreSQL URL. See [local runtime](runtime.md). Hooks report missing prerequisites as failures; they do not silently skip tests.

| Trigger            | Checks                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git pre-commit     | Staged secret scan, repository typecheck, staged format/lint fixes, then tests affected by changes from `HEAD`.                                                   |
| Git pre-push       | Reject direct `main` and non-fast-forward updates, then repository typecheck, format/lint and the full test suite.                                                |
| Claude Code Stop   | On a changed worktree, run repository typecheck, format/lint and affected tests. A failure blocks the stop and returns the output to the agent.                   |
| OMP `session_stop` | Run the same changed-worktree checks before the main session settles, after background work finishes. A failure returns check output and requests a continuation. |

`bun scripts/changed-tests.ts [base]` uses Bun's affected-test selection, with `HEAD` as the default base. Shared configuration, shared package changes, `DESIGN.md`, deleted files and untracked files use the full suite. Commit checks run against the current worktree, including unstaged changes; they do not prove that a partially staged snapshot passes in isolation. Keep commits coherent and use the PR gate as the integrated check.

Claude loads `.claude/settings.json`; OMP discovers `.omp/hooks/post/checks.ts` on a new session. Restart an existing session after installing or changing these hooks. Claude skips repeat checks when its stop hook is already active; OMP caps advisory stop continuations. A hook result is not a substitute for exercising the changed behavior or running `bun run gate` before delivery.

Claude resolves the active worktree from the hook input's `cwd`, even when the session starts in another checkout. OMP stops check subprocesses after 25 seconds so it can return a result before the host's 30-second hook deadline. If that limit is reached, run `bun scripts/agent-check.ts` with a background tool and resolve failures before finishing. Cancellation terminates the checker and its descendants.

## CI stages and security evidence

The `gate` workflow keeps one aggregate `gate` check for required-check consumers. Each required job must succeed. Failure, cancellation or an unexpected skip fails the aggregate.

| Stage   | Responsibility                                                              |
| ------- | --------------------------------------------------------------------------- |
| Quality | Types, formatting, lint, unused code, duplication and migration consistency |
| Tests   | Full test suite against disposable PostgreSQL                               |
| Secrets | Gitleaks scan of Git history                                                |
| Gate    | Require quality, tests and secrets to succeed                               |
| Publish | Build and smoke the selected main commit's image, then publish its digest   |
| Deploy  | Deploy that digest with production-only credentials and verify health       |

All jobs use GitHub-hosted `ubuntu-24.04` runners. PR, main-push and scheduled gates run code checks without production credentials. Only a successful main-push gate can enable automatic deployment. Scheduled gates do not deploy.

### Caches

Quality caches Bun package downloads at `~/.bun/install/cache`. Tests and deployment restore that cache. Keys include the runner OS, architecture, pinned tools and lockfile. Every install still uses `--frozen-lockfile`; the cache does not replace installation or checks. GitHub isolates PR caches from the main branch.

Deployment builds use the GitHub Actions Docker layer cache under `production-image`. Only the trusted publication job requests cache-write access. It builds the selected main SHA from the checkout, not from PR artifacts. Docker validates layer reuse against build inputs; source changes can still invalidate dependency layers because the Dockerfile copies source before installation.

### Temporary security coverage

Issue #233 records the owner's temporary pause of Bun dependency audits, image vulnerability scans and SBOM generation. Those jobs do not run, and the aggregate gate does not claim they passed. Image builds run only in deployment after the code gate succeeds.

The production image smoke test remains required before publication. It checks health, runtime UID and the absence of common shells and package managers. It does not detect vulnerable dependencies or replace an SBOM.

To restore the previous security gates, revert the scoped #233 implementation commit through a PR. Restore audit and image scanning together with the deployment artifact contract and aggregate gate requirements. Review the current workflow before reverting if later changes touch it.

When restored, high and critical findings block delivery, including findings without a fix. Scanner errors and missing reports also block delivery. Do not hide findings with blanket ignore flags.

### Evidence and limits

Deployment evidence records the selected commit, lockfile hash, successful push gate run and attempt, build run and attempt, image config digest and published image digest. The manifest explicitly marks security scans as paused. The publisher verifies the archive's config digest and the registry manifest before it passes an immutable digest to deployment.

Identity evidence and deployment results expire after 90 days. Image archives, audit reports, vulnerability reports and SBOMs are not retained or generated in this mode. Registry images need their own retention policy. Copy required records to an approved archive before expiry.

Passing code checks and image smoke tests does not prove vulnerability-free dependencies, complete component inventory or release approval. These records are not signed attestations or an independent security assessment. See [hosted deployment](deploy.md#security-and-audit-evidence) for credential boundaries and rollback constraints.

## Risk and evidence

| Risk       | Example                                                              | Required evidence                                                               |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ordinary` | Reversible, localized UI copy change                                 | Green required CI.                                                              |
| `impact`   | Authentication or database isolation change affecting multiple areas | Green CI and independent current-head GitHub approval or agent review evidence. |
| `lock-in`  | Irreversible data deletion or a hard-to-reverse external commitment  | Green CI and independent human approval on the exact head.                      |

Assess actual blast radius and reversibility rather than choosing based on file location. Record what was reviewed and who approved it. For an independent agent review, `bun run ship --risk impact --review-file report.json` posts a PR-author-attributed evidence comment. The JSON requires the full exact SHA in `head`, distinct nonempty `taskOwnerAgent` and `reviewerAgent`, `method`, `findings` as one nonempty string that lists each finding with its disposition, and `verdict` exactly `approved`. Repeat the review after a commit that changes the PR's own diff.

```json
{
  "head": "<full commit SHA>",
  "taskOwnerAgent": "implementer (model)",
  "reviewerAgent": "reviewer (model)",
  "method": "What was reviewed and how.",
  "findings": "R1 (high): <defect> -> fixed: <how> | R2 (medium): <defect> -> deferred: <why>",
  "verdict": "approved"
}
```

`ship --merge` waits for a running gate and checks the exact head and the required gate. How it treats a branch that is behind `origin/main` depends on risk:

- An `ordinary` PR merges while behind when GitHub reports no conflicts. Main moves every few minutes and the gate takes about two, so requiring current main stalls merges. The gate on every push to main is the backstop: fix or revert a red main before shipping anything else.
- An `impact` or `lock-in` PR must include current main. Ship merges `origin/main` into the branch with a merge commit (no rebase, no force-push), pushes, waits for the new gate and retries up to six times. On a conflict it aborts the merge and stops.
- A review or approval of an earlier head, for impact and lock-in alike, still counts when that head is an ancestor of the current head and the PR's own change is identical: the exact diff from where it meets main, ignoring only blob ids and hunk line numbers. Whitespace, context lines, binary content and file modes count. A merge that resolves conflicts, a main change next to the PR's lines or any edit to the PR's own lines requires a new review. `--review-file` accepts a report for such an earlier head too.
- Carried-over review does not cover a main change elsewhere that alters what the PR's code means; the gate catches build and test breakage, not every semantic change.

Every other new commit invalidates review, and every new head needs its own green gate. It cannot establish that an account represents a human, that agents are independent, or that a review was substantive. These are team conventions, not cryptographically verified or server-enforced guarantees.

Local workflow checks are not equivalent to server enforcement. On an eligible plan, configure and verify private-repo branch protection and required CI, and verify who can bypass them. A private GitHub Free repository may instead operate in explicitly approved convention mode. In that mode direct pushes and bypasses are possible, and local ship checks do not give an atomic guarantee that the base stays up to date through merge. The team must follow the workflow voluntarily; do not represent it as server-enforced. Do not automatically upgrade the account or switch the repository to public. Repo collaborators and board collaborators are separate, and invitation status is not proof of access.
