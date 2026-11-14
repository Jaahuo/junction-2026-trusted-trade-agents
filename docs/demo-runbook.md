# Demo runbook

This how-to guide gets the demo server onto a public quick tunnel, connects the test host to it, and proves scenarios 1 and 2 before each rehearsal and recording.
The scenarios are in the PRD section [Demo and build order](prd.md#demo-and-build-order).
The REST routes are in [SPEC-003](specs.md#spec-003-tools-routes-and-errors), and the MCP endpoint is in SPEC-012.

You need a worktree that `bun scripts/runtime.ts setup` has prepared, and Docker running.
`bun run runtime:status` shows this worktree's API port; this guide calls it `<port>`.

## 1. Keys

1. Create the signing keys once and keep them:

   ```sh
   bun scripts/generate-keys.ts >> .env
   ```

   This appends `OFFER_SIGNING_JWK`, `OFFER_SIGNING_KID` and `BUYER_SIGNING_JWK` into the ignored `.env`.
   Offers are signed with these keys.
   Keep the same `.env` for the whole demo day, so offers issued before a server or tunnel restart stay valid after it.
   Without them a non-production server makes a new key per process, and a restart invalidates every open offer.

2. Add `VALIO_AIMO_API_KEY` (and `VALIO_AIMO_PORTAL_PASSWORD` if you use the portal) to `.env`, and set `WHOLESALER_LIVE=mock`.
   Offers read live price and availability only with both set (SPEC-005, #100); any other value omits every line `NO_PRICE` and signs no offer.
   Get the values from the organizers or a teammate.
   Never put a key anywhere other than `.env`.

3. Leave `.env.local` alone: `bun scripts/runtime.ts setup` regenerates it with this worktree's ports and database.

## 2. Build and start

```sh
bun run production
```

This builds the web app, the MCP Apps views and the server, and serves all of them on `<port>`.
Views render in a host only after a build: `bun run dev` does not build them.
If you run `bun run dev` instead, run `bun run build` first and again after each change to `contexts/views`.

## 3. Quick tunnel

1. In a second terminal, open a quick tunnel to the server:

   ```sh
   npx -y cloudflared tunnel --no-autoupdate --url http://localhost:<port>
   ```

   It prints a `https://<random>.trycloudflare.com` URL.
   A quick tunnel needs no Cloudflare account, and it gets a new URL on every start.

2. Set the tunnel URL in `.env`:

   ```sh
   PUBLIC_BASE_URL=https://<random>.trycloudflare.com
   ```

3. Stop and restart `bun run production`, so tool texts and approval links carry the public URL.

4. Check the public health route:

   ```sh
   curl -s $PUBLIC_BASE_URL/api/health
   ```

   It prints `{"ok":true}`.

When the team moves to a hosted server, use its URL as `PUBLIC_BASE_URL` and skip the tunnel.

## 4. MCP view tools

Set `MCP_VIEW_TOOLS` in `.env`:

- `off` until the host spike (#9) records that the first test host renders MCP Apps views.
  The model then gets the order tools only, and the approver approves on the `/approvals` page through the `approvalUrl` in the tool text.
- The value that #9 records in [host support](host-support.md), once it has a result.
  `app` (the default) exposes the view-only tools to the approval card.

Restart the server after a change.

## 5. Connect the host

1. In the host's connector or MCP settings, add a server with the URL `<PUBLIC_BASE_URL>/mcp`.
2. Choose no authentication.
   The first build has no accounts; every request acts as the demo account (SPEC-002).
3. Start a new chat and check that the host lists the tools, for example `search_products`.

After every tunnel restart the URL changes.
Then update `PUBLIC_BASE_URL`, restart the server, and in the host remove the connector and add it again with the new `/mcp` URL (or edit its URL and reconnect).
A host keeps the old URL until you do.

Open WebUI 0.13.3 also works as a host against `/mcp` (voice spike #45).

## 6. Before each rehearsal and recording

Run these from the worktree that serves the demo, in order:
Import the private catalogue bundle first with the [catalogue import procedure](catalogue-import.md). Include its demo metadata.
Resets preserve that import. Scripts read PostgreSQL, not the source directory.

1. Reset the database to the demo state:

   ```sh
   bun run db:reset
   ```

   It resets only this worktree's database, so run it in the worktree whose server the host reaches.

2. Before a recording, check that the demo products still fit the live data.
   Use the requested date from imported demo metadata, or the deliver-by date that the demo sentence names:

   ```sh
   bun scripts/check-demo-data.ts --date <YYYY-MM-DD>
   ```

   It ends with `S1 ok` and `S2 ok`.
   If a line says `not ok`, pick new products before you record.

3. Prove both scenarios end to end:

   ```sh
   bun scripts/demo-smoke.ts --scenario 1
   bun scripts/demo-smoke.ts --scenario 2
   ```

   Each run starts with `bun run db:reset`.
   Each step prints `ok <step>`; a failure prints `FAIL step <step>` with the HTTP status and error code, and exits 1.
   The run leaves a placed order, so run `bun run db:reset` once more before you record.
   Wait a few seconds between smoke scripts and before the first chat request to avoid upstream rate limits.

### Trust that grows: the substitute beats

`bun run db:reset` seeds two approved orders of the scenario 3 substitute (`s3Substitute` in imported demo metadata), so the next approval of that pair is the third.

1. Ask for the scenario 3 product. The original is short, so the agent offers the substitute for the rest, and the order waits for approval with `SUBSTITUTION`.
2. Approve it. The confirmation asks "✦ You've approved … 3 times. Let the agent do this without asking?". Press **Yes, automatically**.
3. Ask for the scenario 3 product again, and have the agent place the substitute's offer as its own order. It is placed without asking, and the order log says "Substitute allowed without asking: standing approval given …". The short original still asks, because its amount differs from the request.
4. Show the rule in the agent limits view, and remove it there.

The reject beat: reject a substitute and press **Don't suggest again** on the declined card. The next request for the scenario 3 product gets no offer of that substitute.

Run `bun run db:reset` between takes: a saved rule lasts until the reset, and a new mandate version makes open orders stale.

### Smoke script options

| Option                | Effect                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scenario 1\|2`     | Scenario 1: search, offers, place (`placed`, no reasons), audit record. Scenario 2: place (`pending_approval`, `SPEND_OVER_LIMIT`), pending list, approve, `placed`. |
| `--base-url <url>`    | The server to test. Default: `PUBLIC_BASE_URL`, else `http://127.0.0.1:$PORT` of this worktree.                                                                      |
| `--no-reset`          | Skip `bun run db:reset`, for a hosted server whose database this worktree cannot reset.                                                                              |
| `--database-env NAME` | Read imported demo metadata from the database URL in environment variable `NAME`. Required for another application target. Also requires `--no-reset`.               |

The server, not the script, reads `WHOLESALER_LIVE`; start it with `WHOLESALER_LIVE=mock`.
If `offers` fails with `omitted: NO_PRICE`, the server has no live price source: check `WHOLESALER_LIVE` and `VALIO_AIMO_API_KEY`.

## Check the chat host

The smoke script proves the REST routes.
It does not show what the model does with the tools: a model can pick another product, change an offer token while it copies it, or stop before it places the order.
The chat check sends the demo sentences to the Buyer agent in Open WebUI through a real browser and reports the tool calls, the stored order and the reply.

1. Start the server and Open WebUI as [the buyer agent prompt page](buyer-agent-prompt.md#start-open-webui-with-the-prompt) says.
   Open WebUI must point at this worktree's API.
2. Run the check:

   ```sh
   bun scripts/chat-check.ts
   ```

   Each scenario prints, per sentence, the seconds, the tool calls and the reply, then `ok` or `FAIL` for each expectation; the command exits 1 when one fails.
   A `FAIL` with `(known: #n)` is a defect that the issue tracks.

3. Run `bun run db:reset` once more before you record: the check leaves orders.

| Option               | Effect                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| `--only <name>`      | Run one scenario of `hosts/openwebui/scenarios.json`.                                 |
| `--scenarios <file>` | Use another scenario file.                                                            |
| `--api <url>`        | Test another server than this worktree's. The check then does not reset the database. |
| `--no-reset`         | Skip `bun run db:reset` before each scenario.                                         |
| `--headed`           | Show the browser.                                                                     |
| `--timeout <s>`      | Seconds to wait for one reply. Default: 480.                                          |

The check needs Google Chrome.
It stops before the first sentence when the server, its MCP endpoint, the host or the model endpoint is down, or when Open WebUI is connected to another server.
The [`verify` skill](../.agents/skills/verify/SKILL.md) explains each failure line and how to add a scenario.

## Restart check

Do this once per demo day, to prove that the team can restart in minutes without losing open offers:

1. Get offers in the host, or call `POST $PUBLIC_BASE_URL/api/offers`, and keep the offer token from the result.
2. Stop the server and the tunnel.
3. Start both again with the same `.env` keys.
4. Set the new tunnel URL as `PUBLIC_BASE_URL`, restart the server, and reconnect the host.
5. Place the kept offer with `POST $PUBLIC_BASE_URL/api/orders`.
   It answers 201.

Offer verification does not compare the token issuer with the current public URL (SPEC-006), so a new tunnel URL keeps the old offers valid.
