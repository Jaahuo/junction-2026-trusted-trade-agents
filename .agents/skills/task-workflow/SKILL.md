---
name: task-workflow
description: Start, coordinate, hand off and synchronize an issue-based task in an isolated worktree.
---

# Task workflow

A person assigns each issue to an owner. The owner alone commits, pushes, opens and merges its PR. Helpers use explicitly disjoint writable paths and do not independently run Git mutations. Use the issue and the candidate's own board, not shared candidate memory.

1. Start an assigned issue with `bun scripts/task.ts start <issue>`. This creates the task worktree, adds the issue to the uniquely linked project if needed, and moves it to In progress. Navigate into the worktree afterward with `wt switch task/<issue>`.
2. Agree scopes and interfaces before parallel edits. Record a handoff with `bun scripts/task.ts handoff <issue> --scope <owner>:<path> --message <text>`; repeat `--scope` for multiple paths.
3. If work depends on another task, wait for its PR to merge, then run `bun scripts/task.ts sync <issue> --depends-on <merged-PR>`. Depend on the merged commit, not a pre-squash branch head.
4. Inspect `bun scripts/task.ts status <issue>`. Integrate helper work and run checks once at the integrated end. Use [ship](../ship/SKILL.md) to open a PR, classify its impact and obtain any required review or approval.
5. After merge, run `bun run task finish <issue> --pr <merged-pr>`. It verifies the task branch, target and merged commit on fetched `origin/main`, closes the issue if still open and moves its board item to Done. Ship adds a `Closes #<issue>` link to task-branch PR bodies, preserving existing closing links.

The authenticated person's project scope is needed for board updates. See [workflow](../../../docs/workflow.md) for permissions, risk examples and enforcement boundaries.
