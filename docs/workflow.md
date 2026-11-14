# Task and pull request workflow

Each candidate has its own GitHub Issues and private board. Issues are created unassigned. A person assigns a task owner, or an agent does so with `gh issue edit <n> --add-assignee <login>` when the person it works for tells it to take that issue or lane. One owner and one worktree are responsible for each independently committing task. Helpers receive disjoint writable paths and explicit interfaces; they do not independently commit, push, open PRs or merge. Coordinate shared files and tooling changes explicitly. A shared folder is not itself a risk classification.

1. Start the assigned issue: `bun scripts/task.ts start <issue>`. The command fetches `origin/main` before Worktrunk creates `task/<issue>` from that remote branch. It adds the issue to the uniquely linked project if needed and moves it to In progress. Navigate to the worktree with `wt switch task/<issue>`. The Worktrunk `pre-start` hook copies `.env` from the primary worktree into the new worktree when it has none. It never overwrites `.env` and skips `.env.local` and `.env.test.local`.
2. Record helper scopes and handoff: `bun scripts/task.ts handoff <issue> --scope <owner>:<path> --message <text>`. Repeat `--scope` as needed.
3. Once a dependency PR has merged, synchronize using `bun scripts/task.ts sync <issue> --depends-on <merged-PR>`. The merged commit, not a pre-squash head, is the dependency.
4. Inspect task state with `bun scripts/task.ts status <issue>`. The current authenticated user needs project access and scope for board updates. Do not rely on the repository Actions token as a Projects credential.
5. Integrate changes, run the applicable checks and gate at the integrated end, and smoke the real changed flow. Document actual results, limitations, risk and review evidence in the PR.
6. The owner runs `bun scripts/ship.ts --risk <risk>` to open or update a PR. The default does not merge. After required evidence and authorization, `bun scripts/ship.ts --risk <risk> --merge` requests the merge. After the merge, it runs step 7 for a `task/<issue>` branch and the worktree cleanup for any other branch. Never force-push or bypass hooks.
   For an ordinary PR, `bun scripts/ship.ts --risk ordinary --auto` returns at once and leaves a detached `ship --merge` that waits for the gate, merges with the same checks and finishes the task; it prints its log path. GitHub auto-merge is not used: the repository has no required checks, so it would merge before CI.
7. When the PR merged outside ship, run `bun run task finish <issue> --pr <merged-pr>`. It verifies the PR merged from `task/<issue>` into main and its merge commit is reachable from fetched `origin/main`, closes the issue if open, moves its board item to Done and cleans up the worktree. Ship adds `Closes #<issue>` to task-branch PR bodies while preserving existing closing links.

CI runs the full gate inside an isolated Linux PID and mount namespace. A system helper creates it, then drops to the runner's original user before executing repository code. This keeps protected host processes outside the cleanup tests without changing cleanup permissions or skipping tests.

## Agents draining the backlog

Many agents can work the backlog at once with the `backlog-loop` skill. `bun scripts/backlog.ts next` lists the issues an agent can finish start to end now; `--all` shows why the others wait. `bun scripts/backlog.ts claim <issue>` creates the remote branch `task/<issue>` through the GitHub refs API, which refuses an existing ref, so of two agents that claim at once exactly one wins and is assigned; the other exits 3 and picks the next issue. Unlike assignment, the claim is atomic across machines. An agent that cannot finish runs `bun scripts/backlog.ts release <issue> --reason <text>` when it pushed no work, or opens a draft PR and labels the issue `blocked`.

An explicit claim accepts an issue assigned only to the authenticated user. It still rejects other assignees, existing reservations and overlapping active scopes. `next` keeps assigned issues out of the unassigned backlog pool.

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

The `gate` workflow runs on pull requests only. It is one job named `gate`, the check that `ship` requires. The job runs the secret scan, the quality checks and the tests in sequence, so one failure or a cancellation fails the check. A new PR head cancels the older gate run of that PR. Nothing gates main: a push to main starts the `deploy` workflow.

| Stage  | Workflow | Responsibility                                                                         |
| ------ | -------- | -------------------------------------------------------------------------------------- |
| Gate   | gate     | Gitleaks scan of Git history, types, format, lint, unused code, duplication, migration |
|        |          | consistency and the full test suite against disposable PostgreSQL                      |
| Build  | deploy   | Build, push and verify the API and chat images in two parallel jobs                    |
| Deploy | deploy   | Wait in the deploy queue, then deploy both digests and verify health                   |
| Smoke  | deploy   | Run each deployed image on the runner and check its runtime; off by default            |

All jobs run on the self-hosted Vultr runners with the labels `self-hosted`, `linux`, `x64` and `junction-ci`, because the account has no GitHub-hosted minutes left. The runners are persistent and privileged: a pull request from any collaborator runs on the same machines as the deployment job. The deployment job removes its SSH key when it ends. Gates never deploy. Every push to main builds and deploys without a gate on the merged commit. The PR gate is the only code check.

### Caches

Each runner keeps Bun package downloads and pinned tools in its home volume between jobs, so the workflows use no cache action for them. Every install still uses `--frozen-lockfile`. Each runner pulls the PostgreSQL and BuildKit images when it starts. The PostgreSQL service keeps its data in memory.

Each runner keeps a Docker layer cache for the API image and one for the chat image in its home volume, under `/home/runner/.cache/buildx`. A build reads the cache of the runner it runs on and replaces it afterward, so the cache does not grow. The GitHub cache service is not used: exporting to it took three minutes per build from these runners. The API Dockerfile installs dependencies from the workspace `package.json` files and `bun.lock` alone, so a source-only change reuses the install layers. A runner that has not built an image yet builds it without a cache. A pull request job runs as the same user on the same runner and can change this cache, so a production build can reuse layers that a pull request wrote. The owner accepted this with the shared runners: it saves about a minute per deploy, mostly the pull of the chat base image.

### Temporary security coverage

Issue #233 records the owner's temporary pause of Bun dependency audits, image vulnerability scans and SBOM generation. Those jobs do not run, and the aggregate gate does not claim they passed. Image builds run only in the deploy workflow.

The image smoke jobs are the last stage and are off: they run only when the repository variable `DEPLOY_SMOKE` is `true`. When on, they report a bad image after it reaches production; they do not stop it. `deploy.ts push` still requires API health and the selected image ID on the host. The smoke jobs check health, a catalogue search, runtime UID and the absence of common shells and package managers. They do not detect vulnerable dependencies or replace an SBOM.

To restore the previous security gates, revert the scoped #233 implementation commit through a PR. Restore audit and image scanning together with the deployment artifact contract and aggregate gate requirements. Review the current workflow before reverting if later changes touch it.

When restored, high and critical findings block delivery, including findings without a fix. Scanner errors and missing reports also block delivery. Do not hide findings with blanket ignore flags.

### Evidence and limits

Deployment evidence records the commit, lockfile hash, build run and attempt, image config digest and published image digest, in one artifact for each image. The manifest explicitly marks security scans as paused. Each build job reads the pushed manifest back, verifies its content hash and compares its config digest with the build's before it passes an immutable digest to deployment.

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

- An `ordinary` PR merges while behind when GitHub reports no conflicts. Main moves every few minutes and the gate takes about two, so requiring current main stalls merges. Main has no gate of its own, so a merge that breaks only in combination with newer main deploys unchecked. Nothing reports it until the next PR gate that includes it fails: fix or revert a broken main before shipping anything else.
- An `impact` or `lock-in` PR must include current main. Ship merges `origin/main` into the branch with a merge commit (no rebase, no force-push), pushes, waits for the new gate and retries up to six times. On a conflict it aborts the merge and stops.
- A review or approval of an earlier head, for impact and lock-in alike, still counts when that head is an ancestor of the current head and the PR's own change is identical: the exact diff from where it meets main, ignoring only blob ids and hunk line numbers. Whitespace, context lines, binary content and file modes count. A merge that resolves conflicts, a main change next to the PR's lines or any edit to the PR's own lines requires a new review. `--review-file` accepts a report for such an earlier head too.
- Carried-over review does not cover a main change elsewhere that alters what the PR's code means; the gate catches build and test breakage, not every semantic change.

Every other new commit invalidates review, and every new head needs its own green gate. It cannot establish that an account represents a human, that agents are independent, or that a review was substantive. These are team conventions, not cryptographically verified or server-enforced guarantees.

Local workflow checks are not equivalent to server enforcement. On an eligible plan, configure and verify private-repo branch protection and required CI, and verify who can bypass them. A private GitHub Free repository may instead operate in explicitly approved convention mode. In that mode direct pushes and bypasses are possible, and local ship checks do not give an atomic guarantee that the base stays up to date through merge. The team must follow the workflow voluntarily; do not represent it as server-enforced. Do not automatically upgrade the account or switch the repository to public. Repo collaborators and board collaborators are separate, and invitation status is not proof of access.
