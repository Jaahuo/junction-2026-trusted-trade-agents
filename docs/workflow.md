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

| Stage        | Responsibility                                                              |
| ------------ | --------------------------------------------------------------------------- |
| Quality      | Types, formatting, lint, unused code, duplication and migration consistency |
| Tests        | Full test suite against disposable PostgreSQL                               |
| Secrets      | Gitleaks scan of Git history                                                |
| Dependencies | Bun audit of the complete workspace lockfile                                |
| Image        | Build the amd64 container once, create its SBOM and scan installed packages |
| Gate         | Require every preceding job to succeed                                      |
| Publish      | Verify a trusted main-push gate artifact and publish that same image        |
| Deploy       | Deploy its digest with production-only credentials and verify health        |

Quality, tests, secrets, dependencies, image builds, publication and deployment use [CRACI runners](https://docs.craci.com/guides/runner-workflows/) with the default image and size. Publication uses the build runner baseline to preserve Docker image identity across artifact loading. The aggregate gate and target selection stay on GitHub-hosted runners. The CRACI GitHub App must have access to this repository before jobs can start. A missing connection leaves jobs queued.

CRACI generates an additional build SBOM automatically. This migration does not configure a blocking egress policy or claim complete SBOM coverage. The existing image scans and delivery evidence remain required.

PR and main-push gates run without production credentials. Scheduled gates refresh security evidence but cannot publish or deploy. Actions and container bases use immutable digests or commit pins. Update these pins deliberately and review the resulting security reports.

### Findings policy

High and critical dependency or image findings block delivery, including findings with no available fix. Scanner errors, invalid reports and missing evidence also block delivery. Low and moderate findings remain in reports; passing the gate does not mean the reports contain no findings. The initial audit reports the moderate esbuild advisory [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99).

Do not use blanket ignore flags or hide unfixed vulnerabilities. A policy exception needs a reviewed issue that names the advisory, affected artifact, owner, mitigation and expiry. The current pipeline has no exception mechanism. Until one is explicitly approved and implemented, fix the finding before delivery.

### Evidence and limits

Download the artifacts from the exact gate and deployment run, including its run attempt. Retain the audit JSON, image scan JSON, CycloneDX SBOM, manifest and checksum file. Match the commit, lockfile hash, run identity and image digest before using them as release evidence. Private reports expire after 90 days; large image archives expire after 7 days to limit storage use. Copy required records to an approved archive before expiry. This retention setting is not a tamper-proof audit store.

The image SBOM inventories detected OS and installed language packages. It includes development dependencies shipped in the runtime image. It does not prove complete coverage of bundled browser code, the Bun executable, application logic or external services. Scanners use advisory databases available at scan time. New advisories can appear after release. Checksums bind files together but do not authenticate their author. These reports are not signed attestations, an independent security assessment or proof of zero vulnerabilities.

Publication uses the selected main commit's successful push-gate artifact, not an artifact from a PR or the triggering run by assumption. Deployment records link the scanned build to the published digest. See [hosted deployment](deploy.md#security-and-audit-evidence) for configuration, enforcement gaps and rollback constraints.

## Risk and evidence

| Risk       | Example                                                              | Required evidence                                                               |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ordinary` | Reversible, localized UI copy change                                 | Green required CI.                                                              |
| `impact`   | Authentication or database isolation change affecting multiple areas | Green CI and independent current-head GitHub approval or agent review evidence. |
| `lock-in`  | Irreversible data deletion or a hard-to-reverse external commitment  | Green CI and independent human approval on the exact head.                      |

Assess actual blast radius and reversibility rather than choosing based on file location. Record what was reviewed and who approved it. For an independent agent review, `bun run ship --risk impact --review-file report.json` posts a PR-author-attributed evidence comment. The JSON requires the full exact SHA in `head`, distinct nonempty `taskOwnerAgent` and `reviewerAgent`, `method`, `findings` as one nonempty string that lists each finding with its disposition, and `verdict` exactly `approved`. Repeat the review after a new commit.

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

The script checks exact head, required gate and current main; updates can invalidate review or checks. It cannot establish that an account represents a human, that agents are independent, or that a review was substantive. These are team conventions, not cryptographically verified or server-enforced guarantees.

Local workflow checks are not equivalent to server enforcement. On an eligible plan, configure and verify private-repo branch protection and required CI, and verify who can bypass them. A private GitHub Free repository may instead operate in explicitly approved convention mode. In that mode direct pushes and bypasses are possible, and local ship checks do not give an atomic guarantee that the base stays up to date through merge. The team must follow the workflow voluntarily; do not represent it as server-enforced. Do not automatically upgrade the account or switch the repository to public. Repo collaborators and board collaborators are separate, and invitation status is not proof of access.
