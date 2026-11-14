# Local runtime

Install [mise](https://mise.jdx.dev), Docker with Compose and Git. Run `mise install` and `bun install`, then `bun scripts/runtime.ts setup`. Start with `bun run dev`; inspect the assigned ports and database with `bun scripts/runtime.ts status`. Worktrunk's project pre-start hook can perform install and setup after you approve project hooks. Follow [workflow](workflow.md) to start task worktrees.

PostgreSQL 17 runs as one Compose service per project. Each worktree receives a separate database and ignored `.env.local` and `.local/runtime.json` settings, including its own ports and app root. Shared credentials and ownership records stay inside the common Git directory, never in tracked content. `.env` holds independent local secrets. Never commit secrets. `bun run db:reset` resets the current worktree's database and loads demo data. `bun scripts/runtime.ts drop --yes` removes only the current worktree's database, not the shared Compose volume. Confirm the current worktree before either operation. Keep dependencies and runtime state local to each worktree.

Setup also generates an ignored `.env.test.local` with the local `TEST_DATABASE_URL`, because `bun test` does not load `.env.local`. Route tests create and remove unique disposable databases on that PostgreSQL instance; they do not reset your worktree data. Run `bun test` or `bun run gate` after setup. CI supplies its own local test URL. Never point tests at a hosted database.

`ship --merge` and `task finish` remove a merged, clean worktree with its database; see [workflow](workflow.md#worktree-cleanup-after-merge). To remove a worktree by hand, stop its servers and run `bun run runtime:drop --yes` from that worktree. Then run `wt remove <branch>` from another worktree. Removing a worktree alone does not delete its database or ownership record. Never tear down the project's shared volume as part of worktree cleanup.

For a demo, run `bun run production` after setup and exercise the actual built application. See [sponsor guidance](sponsors.md) before any optional integration.
