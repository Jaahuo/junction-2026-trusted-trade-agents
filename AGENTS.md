# Agent rules

Use GitHub Issues and the project board for task state. Issues are created unassigned. A person assigns the task owner, or an agent assigns an unassigned issue to the person it works for with `gh issue edit <n> --add-assignee <login>` when that person tells it to take that issue or lane. Each independently committing task has one owner and worktree; helpers have disjoint writable paths and no independent Git, push, PR or merge authority. See [workflow](docs/workflow.md) and [team rules](docs/team-rules.md). No cross-project memory or shared project token.

Before creating any task or exploration worktree, fetch its upstream and use the freshly fetched remote branch as the base, never a stale local branch. For this repository, run `git fetch origin main` and create from `origin/main`. Before exploring an existing worktree, fetch again and compare its HEAD with upstream; distinguish local changes from current upstream behavior. Do not reset or rebase another owner's work.

## Commands

| Command                      | Use                                                                     |
| ---------------------------- | ----------------------------------------------------------------------- |
| `bun run dev`                | Run the API and web app in this worktree.                               |
| `bun run production`         | Build and serve the production demo.                                    |
| `bun check`                  | Typecheck the repository.                                               |
| `bun test`                   | Run tests.                                                              |
| `bun run gate`               | Run the integrated checks.                                              |
| `bun run ship`               | Ship the task through a pull request; see [workflow](docs/workflow.md). |
| `bun run new:context <name>` | Create a bounded context.                                               |
| `bun run db:generate`        | Generate migrations after schema changes.                               |
| `bun run db:reset`           | Reset this worktree's database and load demo data.                      |
| `bun scripts/host-check.ts`  | Run chat sentences in the Open WebUI host; see the `host-check` skill.  |

To run a script in another worktree, use `bun run --cwd <dir> <script>`. `bun --cwd <dir> run <script>` prints usage and exits 0 without running the script.

## Where code goes

Feature code belongs in `contexts/<name>/src/`. Stay within the task's agreed writable scope.

| Layer          | Holds                                | May import                                                                        |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `domain/`      | Types and pure rules                 | `@app/kernel`, `@app/contract`, `domain/`                                         |
| `application/` | Use cases and ports                  | `domain/`, `@app/kernel`, `@app/contract`                                         |
| `infra/`       | Port implementations and `schema.ts` | `application/`, `domain/`, `drizzle-orm`, `@app/contract`, `@app/contract/server` |
| `api/`         | Elysia routes and wiring             | All server layers                                                                 |
| `ui/`          | React screen                         | `domain/`, API types, `@app/contract`, `@app/ui`, `@app/web-kit`                  |

`contexts/notes` is the reference. API routes and screens are discovered by folder, without registration.

## Rules

1. Feature work stays in its context. Explain and coordinate any needed changes to `apps/`, `packages/`, `scripts/` or root config. Agree writable scopes and assess cross-area impact. Shared paths alone do not imply high risk.
2. Do not import another context's files. Call its HTTP API through `import type { Api } from "@ctx/<name>/api"` and an Eden client with `parseDate: false`. Where that import would create a workspace cycle, use `callRoute` from `@app/contract/server` (docs/specs.md SPEC-001).
3. Return expected failures as `Result` from `@app/kernel`; throw only for bugs.
4. Prefix each table with its context name, for example `notes_notes`.
5. After changing `schema.ts`, run `bun run db:generate` and commit the migration.
6. Add dependencies to the context's `package.json`, using `catalog:` where available.
7. Add meaningful `bun:test` coverage for domain rules and routes, including regressions and failure paths relevant to the change.
8. Never use `--no-verify`, `any`, `!`, `@ts-ignore` or a lint disable comment to pass the gate. Fix the cause.
9. Delete unused code. Extract clones inside the context when jscpd reports them.
10. Commit focused changes. Never force-push. Use the task and PR workflow, with green CI for ordinary reversible work, independent review for high-impact changes and human approval for hard-to-reverse decisions.
11. Keep secrets out of Git. Put local secrets in ignored `.env`, list names in `.env.example`, and read them with `env("NAME")` from `@app/server-kit`, not `process.env`. Do not share project tokens across repos.
12. Put external APIs and LLMs behind application ports and infra adapters. `contexts/notes/src/infra/claude-summarizer.ts` is the reference. Test with a fake, not the real service. Build the adapter's test fixtures from a recorded live response with invented ids, not from the API documentation alone.
13. Read [DESIGN.md](DESIGN.md) before building a screen. Use `@app/ui` components, not raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or `<table>`. MCP App views in `contexts/views` are the exception: they are framework-agnostic Lit web components that use the shared view styles in `contexts/views/src/shared/styles.ts` and native elements inside their shadow DOM. See [DESIGN.md](DESIGN.md#views).
14. Style with theme tokens, not raw palette colors, arbitrary values or inline styles. On an `@app/ui` component, `className` may only change layout. Views use the view tokens in `contexts/views/src/shared/styles.ts`.
15. If a component, variant or token is missing, coordinate the shared change, update `packages/ui` and `DESIGN.md` together, and assess its cross-area impact.
16. Export demo `seed` from `api/seed.ts` and pass it in `context`. Reset should leave a state worth showing.
17. Resolve lockfile conflicts deliberately and regenerate the lockfile as needed; do not discard a teammate's dependency changes.
18. The contract lives in [specs](docs/specs.md) and `@app/contract`. Change it only as [team rules](docs/team-rules.md) R-08 says.

## Stack

Elysia 2 is pinned to a release candidate in the root catalog. Do not change that version. Use the `elysiajs` skill for Elysia questions. Route options come before the handler: `.post(path, options, handler)`.

Tool versions are pinned in `mise.toml`; change versions there, not with a global install. The stack is Bun, Elysia 2, Eden, Drizzle on PostgreSQL, React, TanStack Query, wouter, Tailwind, Lit (MCP App views) and Vite+ (oxlint and oxfmt).
