---
name: verify
description: Prove that a change works in this app before you report it done or ship it. Says which of the existing checks to run for the kind of change, in which order, and how to read their results.
---

# Verify a change

Run the checks that the change needs, cheapest first, and stop at the first failure. Each check proves one thing; a pass of one says nothing about the next.

| Check                                                            | Proves                                                             | Run it when the change touches                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1. `bun run gate`                                                | Types, lint, tests, unused code, migrations and the build.         | Anything.                                                                            |
| 2. `bun scripts/demo-smoke.ts --scenario 1`, then `--scenario 2` | The REST routes place an order and take an approval.               | `contexts/catalog`, `offers`, `orders`, `mandates`, `accounts`, `packages/contract`. |
| 3. `bun scripts/check-demo-data.ts --date <deliver-by date>`     | The demo products still have price, stock and a delivery date.     | `data/`, the seed, or a recording today.                                             |
| 4. `bun scripts/chat-check.ts`                                   | What the model does with the tools and the views in the chat host. | `contexts/mcp`, `contexts/views`, `skills/`, `docs/buyer-agent-prompt.md`, `hosts/`. |
| 5. Open the screen in a browser, with the console open           | A web screen renders and its actions work.                         | `apps/web`, `contexts/*/src/ui`, `packages/ui`.                                      |

## Prerequisites

- Checks 2 to 5 need this worktree's server: `bun run production`. Views render only from a build.
- Checks 2 and 3 need `WHOLESALER_LIVE=mock` and the wholesaler key in `.env`. Wait a few seconds between them: the wholesaler refuses a burst.
- Check 4 needs Open WebUI (`bun scripts/openwebui.ts up`), its model endpoint and Google Chrome. Open WebUI must point at this worktree's API: empty `OPENWEBUI_MCP_URL` in `hosts/openwebui/.env`, then run `bun scripts/openwebui.ts setup`. A task worktree has no `hosts/openwebui/.env`; copy it from the main checkout first. When you finish, run the setup again from the checkout that the host should keep serving.
- Checks 2 and 4 reset this worktree's database. Run `bun run db:reset` afterwards to leave a clean demo state.

## Read the chat check

Each scenario lists, per sentence, the seconds, the tool calls and the reply, then `ok` or `FAIL` for each expectation. The command exits 1 when one fails. It stops before the first sentence, with the cause, when the server, its MCP endpoint, the host or the model endpoint is down, or when the host is connected to another server. Use `--only <name>` for one scenario and `--headed` to watch.

| Line                                                  | Meaning                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `FAIL … (known: #n)`                                  | A defect that the issue tracks. Say so; do not call the run green.                                     |
| `place_order ERROR OFFER_INVALID, token miscopied: …` | The model changed the signed offer token while it copied it. The server is right to refuse.            |
| `get_offers ERROR UPSTREAM_FAILED`                    | The wholesaler did not answer, often a rate limit. Wait and run again.                                 |
| `… ERROR HOST_ERROR, …` or `NO_RESULT`                | Open WebUI refused or dropped the model's output, for example a tool call cut off by the output limit. |
| `unasked dialog cancelled: …`                         | A view asked for a tool call on its own. The check cancels it so the next step can run.                |
| `no "…" button in a view`, `no dialog to …`           | A step could not run. Look at the screenshot in `.local/chat-check/`.                                  |

One run is one sample of a model. Run a sentence three times before you call a model behaviour fixed.

To cover a new behaviour, add a scenario to `hosts/openwebui/scenarios.json`. A step is `say`, `click` (a pattern for a button in a view) or `dialog` (`confirm` or `cancel`). An expectation is about tool calls or the stored order, never about the wording of a reply: `called`, `notCalled`, `noError`, `order` (`placed`, `pending_approval`, `rejected`, `any` or `none`, with an optional `reason`) and `maxOrders`. Add `"known": "#<issue>"` to an expectation whose failure the team accepts for now.

## Report

List each check you ran with its result, and each check you did not run with the reason. A check that could not run is not a pass. Put the list in the PR.
