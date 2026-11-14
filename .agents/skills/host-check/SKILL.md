---
name: host-check
description: Run chat sentences in the Open WebUI host and read what the agent did with the tools. Use after a change to the MCP tools, the skill, the buyer prompt, the views or the host setup, and before a demo rehearsal.
---

# Check the chat host

`bun scripts/demo-smoke.ts` proves the REST routes. It does not show what a model does with the tools. `bun scripts/host-check.ts` sends sentences to the Buyer agent in Open WebUI through a real browser and reports each tool call, the stored order and the reply.

1. Start the server under test in this worktree with `bun run production`. Views render only from a build.
2. Start the host with `bun scripts/openwebui.ts up`. It must point at this worktree's API: empty `OPENWEBUI_MCP_URL` in `hosts/openwebui/.env`, or set it to this worktree's port, then run `bun scripts/openwebui.ts setup`.
3. Run `bun scripts/host-check.ts`. Use `--only <name>` for one scenario and `--headed` to watch the browser. A scenario takes one to three minutes on a local model.
4. Read the output. Each scenario lists, per sentence, the seconds, the tool calls in order and the reply, then `ok` or `FAIL` for each expectation. The command exits 1 when an expectation fails.
5. Report the output lines as they are. A `FAIL` with `(known: #n)` is a defect that the issue tracks; say so, and do not call the run green.

The check stops before the first sentence, with the cause, when the server, its MCP endpoint, the host or the model endpoint is down, or when the host is connected to another server.

## Read a failure

| Line                                                  | Meaning                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `place_order ERROR OFFER_INVALID, token miscopied: …` | The model changed the signed offer token while it copied it. The server is right to refuse.                                                 |
| `get_offers ERROR UPSTREAM_FAILED`                    | The wholesaler did not answer, often a rate limit after a burst. Wait and run again.                                                        |
| `… ERROR HOST_ERROR, …`                               | Open WebUI refused the model's output, for example a tool call cut off by the output limit.                                                 |
| `… ERROR NO_RESULT, …`                                | The chat stores no result for the call. The host dropped it.                                                                                |
| `unasked dialog cancelled: …`                         | A view asked for a tool call on its own. The check cancels it so the next step can run.                                                     |
| `no finished reply within … s`                        | The model did not finish. Check the model endpoint before you run again.                                                                    |
| `no "…" button in a view`, `no dialog to …`           | A step could not run, so the scenario fails. The view did not render or has no such button. Look at the screenshot in `.local/host-check/`. |

## Add a scenario

Scenarios are in `hosts/openwebui/scenarios.json`. A step is `{ "say": "<sentence>" }`, `{ "click": "<pattern for a button in a view>" }` or `{ "dialog": "confirm" | "cancel" }`. An expectation is about tool calls or the stored order, never about the wording of the reply:

| Expectation                                                                     | Holds when                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `{ "called": "<tool>" }`, `{ "notCalled": "<tool>" }`                           | The agent called the tool at least once, or never. A call that a view makes shows as a `dialog` line and does not count. |
| `{ "noError": "<CODE>" }`                                                       | No tool call was refused with that error code.                                                                           |
| `{ "order": "placed" \| "pending_approval" \| "rejected", "reason": "<CODE>" }` | The last order that the chat created has that status now, and that reason when one is given.                             |
| `{ "order": "any" }`, `{ "order": "none" }`                                     | The chat created an order, or none.                                                                                      |
| `{ "maxOrders": <n> }`                                                          | The chat created at most that many orders.                                                                               |

Every scenario also checks that every step ran and that the agent replied. Add `"known": "#<issue>"` to an expectation whose failure the team accepts for now, and remove it when the issue closes.

## Limits

- The database is reset before each scenario. With `--api <url>` the check tests another server and does not reset its database, so results depend on the orders already there.
- One run is one sample of a model. Run a sentence three times before you call a model behaviour fixed.
- The check proves the flow in Open WebUI with the configured model. It says nothing about another host or model.
- It needs Google Chrome on the machine.
