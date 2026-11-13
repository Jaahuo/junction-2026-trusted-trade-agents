# junction-2026-trusted-trade-agents

> **Unprotected main:** GitHub does not enforce pull requests, CI checks, or an up-to-date base; there is no atomic base guarantee. Coordinate merges manually and enable server-side protection when eligible.

## Setup

Install mise, Docker with Compose, Git and GitHub CLI. Run `mise install`, then `bun install --frozen-lockfile` and `bun run setup` to initialize this worktree's local PostgreSQL runtime. Keep secrets in ignored `.env`; see `.env.example` and [runtime guidance](docs/runtime.md).

## Challenge data

The `data/` directory contains the five original challenge files supplied for this project:

- `challenge-327.pdf`
- `valio_aimo_junction26_delivery_reliability.csv`
- `valio_aimo_junction26_carbon_footprint.csv`
- `valio_aimo_junction26_product_data_schema.json`
- `valio_aimo_junction26_product_data.json`

These files remain byte-for-byte unchanged. Formatting excludes `data/` to preserve the source files. The product dataset contains 17,546 records. The template's MIT license and attribution remain unchanged; this project does not assign that license to the supplied challenge data.

## Commands

- `bun run dev`: start the app.
- `bun run production`: build and serve the production demo.
- `bun run gate`: run integrated checks.
- `bun run task`: manage assigned issues; see [workflow](docs/workflow.md).
- `bun run ship`: open or merge a PR following the workflow.
- `bun run runtime:status`: inspect the worktree runtime.

See [agent rules](AGENTS.md), [design](DESIGN.md), [sponsor guidance](docs/sponsors.md) and [license](LICENSE).
