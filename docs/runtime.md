# Local runtime

Install [mise](https://mise.jdx.dev), Docker with Compose and Git. Run `mise install` and `bun install`, then `bun scripts/runtime.ts setup`. Start with `bun run dev`; inspect the assigned ports and database with `bun scripts/runtime.ts status`. Worktrunk's project pre-start hook can perform install and setup after you approve project hooks. Follow [workflow](workflow.md) to start task worktrees.

Stop `bun run dev` with SIGINT or SIGTERM. The launcher stops both API and web process groups, including their descendants. If either service fails, the launcher also stops the other service.

PostgreSQL 17 runs as one Compose service per project. Each worktree receives a separate database and ignored `.env.local` and `.local/runtime.json` settings, including its own ports and app root. Shared credentials and ownership records stay inside the common Git directory, never in tracked content. `.env` holds independent local secrets. Never commit secrets. `bun run db:reset` resets the current worktree's database and loads demo data. `bun scripts/runtime.ts drop --yes` removes only the current worktree's database, not the shared Compose volume. Confirm the current worktree before either operation. Keep dependencies and runtime state local to each worktree.

Setup also generates an ignored `.env.test.local` with the local `TEST_DATABASE_URL`, because `bun test` does not load `.env.local`. Route tests create and remove unique disposable databases on that PostgreSQL instance; they do not reset your worktree data. Run `bun test` or `bun run gate` after setup. CI supplies its own local test URL. Never point tests at a hosted database.

Import the catalogue explicitly before search or demo checks. Follow [catalogue import](catalogue-import.md).
`db:reset` preserves the catalogue, import manifest and catalogue migration ledger. It resets the other contexts and uses imported demo metadata for order history.
Dropping the worktree database still removes its catalogue. Reimport from the private bundle only after creating a replacement database.

`ship --merge` and `task finish` stop current-user processes inside a merged, clean worktree before removing its database and worktree; see [workflow](workflow.md#worktree-cleanup-after-merge). They leave other users' processes untouched and do not require elevated privileges. Discovery uses `/proc` on Linux and `lsof` on macOS; caller protection also needs `ps`. These commands keep the worktree if current-user process discovery or termination fails. To remove a worktree by hand, stop its servers and run `bun run runtime:drop --yes` from that worktree. Then run `wt remove <branch>` from another worktree. Removing a worktree alone does not delete its database or ownership record. Never tear down the project's shared volume as part of worktree cleanup.

For a demo, run `bun run production` after setup and exercise the actual built application. See [sponsor guidance](sponsors.md) before any optional integration.

Offers read live prices and availability only when `WHOLESALER_LIVE=mock` is set and `.env` holds `VALIO_AIMO_API_KEY`. In every other case, `get_offers` has no price source. It omits every requested line with reason `NO_PRICE` and a detail that says that no live price source is configured. It signs no offer and calls no other service. The API logs one warning at server start that names the cause: `WHOLESALER_LIVE` is not set, `mock` has no API key, or the value is not a live source. Before a demo, set both values and check that the API log has no `omits every line NO_PRICE` line.
