# junction-2026-trusted-trade-agents

> **Unprotected main:** GitHub does not enforce pull requests, CI checks, or an up-to-date base; there is no atomic base guarantee. Coordinate merges manually and enable server-side protection when eligible.

## Setup

Install mise, Docker with Compose, Git and GitHub CLI. Run `mise install`, then `bun install --frozen-lockfile` and `bun run setup` to initialize this worktree's local PostgreSQL runtime. Keep secrets in ignored `.env`; see `.env.example` and [runtime guidance](docs/runtime.md).

## Product requirements

The [living PRD](docs/prd.md) owns product scope, behavior, acceptance criteria and open questions. Its [change rules](docs/prd.md#document-boundaries-and-change-rules) keep requirements and implementation consistent. Add consolidated specs and ADRs only when needed; do not create a document per change.

## Challenge data

Read the [challenge brief](docs/challenge.md) for requirements, scope and judging criteria. It replaces the original PDF.

Use the supplied [OpenAPI specification](data/open_api.json) for mock API endpoints, request/response schemas and `X-API-Key` authentication. Use the [resource portal](https://junction26.valioaimo.fi/) for access instructions and updates. Keep credentials in ignored `.env`, not in documentation.

The `data/` directory contains the API specification and four original datasets:

- [Delivery reliability](data/valio_aimo_junction26_delivery_reliability.csv)
- [Carbon footprint](data/valio_aimo_junction26_carbon_footprint.csv)
- [Product data schema](data/valio_aimo_junction26_product_data_schema.json)
- [Product data](data/valio_aimo_junction26_product_data.json)

The four dataset files remain byte-for-byte unchanged. Formatting excludes `data/` to preserve the source files. The product dataset contains 17,546 records. Narrow the product selection with static data before querying dynamic prices and availability; do not repeatedly query the full catalog. The template's MIT license and attribution remain unchanged; this project does not assign that license to the supplied challenge resources.

## Commands

- `bun run dev`: start the app.
- `bun run production`: build and serve the production demo.
- `bun run gate`: run integrated checks.
- `bun run task`: manage assigned issues; see [workflow](docs/workflow.md).
- `bun run ship`: open or merge a PR following the workflow.
- `bun run runtime:status`: inspect the worktree runtime.

See [agent rules](AGENTS.md), [writing skills](docs/agent-skills.md), [design](DESIGN.md), [sponsor guidance](docs/sponsors.md) and [license](LICENSE).
