# Team rules

These rules are for every person and agent who works on an issue of the product build. They let several owners work in parallel. They add to [AGENTS.md](../AGENTS.md) and [workflow](workflow.md); where a rule here seems to conflict with them, AGENTS.md and workflow win, unless the rule here states the change.

## Rules

1. R-01 Take an open issue that has no `blocked` or `needs-decision` label and whose "Depends on" issues are merged. You may start before the issues on its "Merge after" line merge, but run `task.ts sync` after each one merges and before you ship (AGENTS.md:3).
2. R-02 Issues are created unassigned: a person assigns the issue, or an agent assigns it to the person it works for with `gh issue edit <n> --add-assignee <login>` when that person tells it to take that issue or lane. Never change an existing assignee (AGENTS.md:3; workflow.md:3).
3. R-03 Start with `bun scripts/task.ts start <issue>`: one issue, one owner, one worktree `task/<issue>` (workflow.md:5).
4. R-04 Take `demo-critical` issues first, then the lowest wave. A view issue never blocks the core flow, and no core issue depends on one.
5. R-05 Edit only the paths in your issue's Owns list; the one exception is an optional contract field or export under R-08. For another path, comment on the issue that owns it, or ask a person to change the Owns lists (AGENTS.md:23, 37).
6. R-06 A helper gets a disjoint sub-path recorded with `task.ts handoff` and does not commit, push or open a PR (AGENTS.md:3; workflow.md:6).
7. R-07 Ownership is per file: each file under root config (`package.json`, `bun.lock`, `knip.json`, `.env.example`), `apps/**`, `packages/**`, `scripts/**` and `DESIGN.md` is in the Owns list of at most one issue per wave, and two issues may own different files in one folder. After wave 0, a context's `package.json` changes only through R-09, and `packages/contract/src` also changes through R-08 (AGENTS.md:37, 51).
8. R-08 `docs/specs.md` and `packages/contract` change together: a new optional field or a new export may go in the PR of the issue that needs it, if that PR also updates the SPEC section and the owner of `packages/contract` reviews it. A rename, a removal, a new required field or a changed meaning needs its own issue labelled `area:contract` and `risk:impact` that names the section, the change and every consumer, updates them all in one PR and keeps section ids stable (docs/prd.md:22, 28-32).
9. R-09 After wave 0, a new dependency, a new `.env.example` name or a change to `apps/api/src/server.ts` goes in a shared-file PR: the issue owner asks the repository owner in the issue, one shared-file PR at a time changes the root catalog, the manifest, knip, `.env.example` or the server and regenerates `bun.lock`, and then dependent issues run `task.ts sync`. On a `bun.lock` conflict, take the copy on `origin/main`, run `bun install`, and keep every teammate's dependency (AGENTS.md:42, 53).
10. R-10 Each issue has exactly one `area:*`, `wave:*`, `kind:*` and `risk:*` label. The risk label equals the `--risk` value passed to `bun run ship` (workflow.md:10, 47-51).
11. R-11 Add `blocked` with a comment that names the blocker, and remove it when the blocker clears (team convention; no earlier rule).
12. R-12 For a product decision, add `needs-decision`, comment the decision, the options, their effect and a recommendation, mention the team, and continue work that does not depend on it (docs/prd.md:27).
13. R-13 A behaviour PR names the PRD heading and the SPEC section it implements, and when the behaviour differs from docs/prd.md or docs/specs.md, the same PR updates them (docs/prd.md:28). A PRD change needs the team's agreement under R-12 first, and a Decided PRD choice never changes without it.
14. R-14 A cross-context call goes through an application port, an Eden client typed by `import type { Api }` with `parseDate: false` and `selfBaseUrl()`, or `callRoute` where the import would create a cycle, and a fake in tests (AGENTS.md:38, 48).
15. R-15 Only a wholesaler adapter in `src/infra/` names the wholesaler (docs/prd.md:82).
16. R-16 Domain and ui code import only the `@app/contract` root; `@app/contract/server` is for infra and api (AGENTS.md:27-31).
17. R-17 Screens use `@app/ui` components and theme tokens. Views are Lit web components that use the view styles and tokens in `contexts/views/src/shared/styles.ts`. A PR that changes a screen or view includes a screenshot of each changed state (AGENTS.md:49-51).
18. R-18 Signing keys live in an ignored `.env`; create them with `bun scripts/generate-keys.ts`, which arrives with the foundation issue. The wholesaler API key comes from the user: put it only in your worktree's `.env`, never in an issue, PR, commit or chat (AGENTS.md:47).
19. R-19 Fetch `origin/main` before you create a worktree, and run `task.ts sync` after a dependency merges (AGENTS.md:5; workflow.md:7).
20. R-20 An issue is done when its PR merged through `bun run ship` lists each acceptance criterion with its actual result, the gate result, the screenshots, and the risk evidence, and `bun run task finish` ran (workflow.md:9-11, 47-53).
21. R-21 Approval is human only. Never give the model a tool that decides an approval or changes a mandate; such tools are view-only (docs/specs.md SPEC-012).
22. R-22 Call the wholesaler mock only with targeted requests for the products a task needs, or through the app's adapter. Never pull whole datasets from it. Import the private challenge files once into PostgreSQL for bulk catalogue access. A script that calls the mock states its request ceiling.
23. R-23 Challenge data is for this challenge only. Keep its source files outside Git. Do not copy source rows or values into docs, issues, PRs, tracked fixtures or seed files. Use invented products in tests. Import optional demo product ids, quantities, observation time and scenario status as private metadata. Removing current files does not remove their Git history; do not make the repository public without a separate history and disclosure review.

## Labels

Each issue has exactly one label of each family `area:`, `wave:`, `kind:` and `risk:` (R-10).

Each `area:` label belongs to exactly one lane. The table gives the default lane for an issue. The label description starts with its lane.

| Lane                          | Areas                                                                   |
| ----------------------------- | ----------------------------------------------------------------------- |
| 1 Catalogue and integration   | `area:catalog`, `area:mandates`, `area:demo`, `area:docs`, `area:infra` |
| 2 Offers and MCP              | `area:offers`, `area:mcp`                                               |
| 3 Contract helpers and orders | `area:contract`, `area:orders`                                          |
| 4 Host integration and views  | `area:views`                                                            |

Issue #9 remains assigned in lane 3 as an exception. Do not change an existing assignee to match the table (R-02).

| Label                                                                                                                                            | When it applies                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `area:contract`, `area:catalog`, `area:offers`, `area:mandates`, `area:orders`, `area:mcp`, `area:views`, `area:infra`, `area:docs`, `area:demo` | The area of the largest owned path. Accounts, server-kit, apps and root files are `area:infra`. Discovery and OpenAPI are `area:docs`. The skill is `area:mcp`. Wholesaler adapters are `area:offers`.                |
| `wave:0` … `wave:4`                                                                                                                              | The build-step group: 0 foundation and spikes, 1 core contexts, 2 host and approval, 3 exceptions, docs and skill, 4 later steps. A wave is not a time gate; an issue starts when its "Depends on" issues are merged. |
| `kind:feature`, `kind:spike`, `kind:docs`, `kind:chore`                                                                                          | The kind of work.                                                                                                                                                                                                     |
| `risk:ordinary`, `risk:impact`, `risk:lock-in`                                                                                                   | The `--risk` value of `bun run ship`.                                                                                                                                                                                 |
| `needs-decision`                                                                                                                                 | A product decision blocks the issue (R-12).                                                                                                                                                                           |
| `blocked`                                                                                                                                        | Something outside the issue blocks it (R-11).                                                                                                                                                                         |
| `demo-critical`                                                                                                                                  | A demo scenario or the submission needs the issue. Take it first (R-04).                                                                                                                                              |
