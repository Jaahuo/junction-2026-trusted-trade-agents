# Submission

The submission closes on Sunday, November 15, 2026 at 10:00 Helsinki time.
A person must record and upload the video, export and upload the deck, submit the entry, and paste the receipt in [issue #35](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/35).
This page prepares those artifacts; it is not a submission receipt.

## Links and release record

| Item        | Link                                                               | Status                                                                                                                              |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Pitch video | Not uploaded                                                       | Not recorded; maximum 2:00                                                                                                          |
| Deck PDF    | [trusted-trade-agents-slides.pdf](trusted-trade-agents-slides.pdf) | Exported and in the repository; upload it with the submission                                                                       |
| Live demo   | https://199-247-4-99.sslip.io                                      | `/` and `/api/health` returned HTTP 200 on November 15; check again before submission and throughout judging                        |
| Source      | https://github.com/Jaahuo/junction-2026-trusted-trade-agents       | **Public** since November 15; the page opened without a login. The history of `main` was rewritten without the challenge data files |

After recording, state the actual video length alongside the uploaded file and record the commit of the build shown.
Before submitting, open each artifact and the demo without a login.
The source must be public and open without a login.
Issue [#299](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/299) records the cleanup and the publication decision: this repository goes public after the history rewrite.
The rewrite and the public switch are done. The source link is submission-ready.
The person submitting must add the actual video and deck links here and paste the submission receipt in issue #35 before the deadline.
The submission form URL is not recorded here.

## What the demo proves and what it does not

- The synthetic challenge catalogue and demo metadata are imported into PostgreSQL from a private bundle. Prices and availability come from the challenge's wholesaler mock when configured; they can change.
- Offers are signed. An independent verifier can discover the published key and verify an offer. The server applies mandate limits and order guardrails, records decisions and provides an audit trail.
- The mandate is AP2-style, not a claim of AP2 conformance. The server signs it using a buyer key in simulated server custody. The current mandate lookup uses the stored mandate; the signature helper is not called on that lookup. Independent buyer-side key custody and signature verification on use remain work to do. See [mandate lookup](../contexts/mandates/src/application/mandates.ts) and [verification helper](../packages/contract/src/server/mandate-token.ts).
- The demo has one account and no authentication. Anyone who can reach the REST endpoints can make approval decisions. MCP view-tool visibility depends on the host and is not an authorization boundary.
- The mock is not a production wholesaler connection. Accounts and authorization, real payment, buyer-controlled key custody and another wholesaler adapter are future work. The demo account has no credit limit.
- [The order statuses have a documented Peppol/UBL mapping; XML export and Peppol delivery are next steps](specs.md#peppolubl-status-mapping). No Peppol integration is implemented.

## Before recording

Use the [demo runbook](demo-runbook.md) and the [catalogue import procedure](catalogue-import.md).
The operator must select the database serving the demo and obtain approval for any hosted import or reset.
Do not expose private raw source files, credentials or bulk metadata in the recording or submission. Product displays needed for the demo are legitimate.

1. Confirm the private bundle, including demo metadata, was imported into the selected PostgreSQL database. Reset preserves the import. There is no runtime source-file fallback.
2. Run `bun run db:reset` on the intended worktree database. For a hosted target, follow its separately approved reset procedure.
3. Run `bun scripts/check-demo-data.ts --date <requestedDate>` using the date from the imported metadata or the demo request. For another database, use the documented `--database-env NAME` selection. Confirm `S1 sentence ok`, `S1 ok` and `S2 ok`. The checker prints `S3` and `LATE` only when those metadata entries exist; if present, they must also print `ok`.
4. If imported `s3` is null, record scenario 3 using a fictional fixture and say “This scenario uses a fixture” in the video. The current [scenario 3 script](../scripts/demo-scenario-3.ts) requires a configured live mock and does not support `WHOLESALER_LIVE=fixture`; a runnable fixture setup must be provided before that clip can be recorded. Do not present a live clip as a fixture or claim this fallback is ready. If `s3` is present but fails the check, do not record it as a working live scenario.
5. Use a missed cut-off clip only when imported `late` is set and its current check passes. Otherwise omit it.
6. Run the scenario 1 and 2 smoke checks in the runbook. They create orders and reset the local database; use the runbook's target-selection options for a hosted server. Reset the intended demo state again before recording.
7. Build the views and rehearse in Open WebUI with voice, the configured model, and the MCP connection to the intended server. Check the in-chat card and its confirmation; keep the phone approval page ready as fallback. Host support and model tool choices vary, so record only behavior observed in the take. See [host support](host-support.md#measured-results).
8. Recheck the demo URL and public source access. Record the build commit and duration after the take. Do not submit until every required link opens without login.

## Video shot list

Maximum runtime: 2:00. Keep the chef speaking in the kitchen as the main shot, with the agent screen beside the kitchen. Use observed results, not a promised model response.

| Time      | Picture and narration                                                                                                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:20 | **Protocol first.** Show discovery and the MCP endpoint, then an offer verified against the published key. Say: “An agent discovers the ordering service, verifies a signed offer, and works within an AP2-style mandate.” Briefly disclose simulated server custody.            |
| 0:20–0:45 | **Chef and routine order.** The chef speaks a small request. Show Open WebUI searching, obtaining an offer and placing the order within the configured limits. Show the resulting status and audit record.                                                                       |
| 0:45–1:20 | **Human control.** The chef asks for a larger order. Show the spend-limit reason and the approval card. A person approves; show the resulting status. If the card action fails, use the phone approval page. Mention that the demo has no authentication.                        |
| 1:20–1:45 | **Short stock.** If the current scenario 3 data passes, show the short original and proposed substitute awaiting approval. If `s3` is null, use the fictional fixture only when a runnable setup exists and explicitly say it is a fixture. Show the actual reasons and outcome. |
| 1:45–2:00 | **Close.** Summarize the open discovery and signed offers, and distinguish the mock from a production connection. Say: “the order statuses have a documented Peppol/UBL mapping; XML export and Peppol delivery are next steps.”                                                 |

The [mapping](specs.md#peppolubl-status-mapping) is documentation, not delivery integration. Do not include a cut-off clip unless the `late` condition above is met.

## Seven-slide deck text

### 1. Trusted Trade Agents

**A supplier-hosted ordering service for buyer agents**

Discover the service, obtain signed offers, and order within buyer-defined limits.

### 2. The need

Kitchen staff need to order while their hands and attention are busy.
An agent can help, but the buyer needs control over what it may order and when a person must decide.

### 3. End-to-end demo

The chef speaks a request. The agent searches the catalogue, obtains an offer and submits an order.
The server checks the order and records its outcome and audit trail.
Show a still from the actual recorded take.

### 4. Autonomy with controls

An AP2-style mandate expresses buyer limits. The server applies those limits and its order guardrails.
An order outside the limits can wait for a person's decision.
The demonstration uses a server-held buyer key and an unauthenticated demo account.

### 5. Exceptions

The service can explain a shortfall and offer a substitute for approval.
Offer expiry and invalid signatures have explicit outcomes.
Availability and the exact reasons depend on current mock data and the request.

### 6. Open contract

Discovery, OpenAPI, MCP and the ordering skill describe how a client connects.
Signed offers can be verified with the published key.
The order statuses have a documented [Peppol/UBL mapping](specs.md#peppolubl-status-mapping); XML export and Peppol delivery are next steps.

### 7. Boundaries and next steps

- Challenge catalogue and wholesaler mock, not a production integration; scenario 3 may require a disclosed fictional fixture.
- One unauthenticated demo account; human approval endpoints are publicly callable.
- Buyer key custody is simulated on the server. Buyer-side custody and mandate signature verification on use are future work.
- Add accounts and authorization, real payment and another wholesaler adapter before production use.

## Partner challenges

[Implementation and partner technologies](implementation.md#partner-technologies) holds the evidence for each claim below.
We enter the Nemotron, Codex, ElevenLabs, Vultr and Tiger Data challenges.

### Partner slide text

**Kicker:** Partner technologies. **Title:** Built with.

| Partner                      | Card title          | Card text                                                                                                                                           |
| ---------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| NVIDIA Nemotron 3.5 Super VL | The chat agent      | Powers the chat in our Open WebUI, from a chef's sentence to a checked order. Fast enough to keep up with a busy kitchen.                           |
| OpenAI Codex                 | A parallel dev team | Hundreds of agent sessions on GitHub issues, each in its own worktree. It reviewed Claude's code hundreds of times and found nearly as many issues. |
| Vultr                        | Runs it live        | API, MCP endpoint, web app, chat and CI, set up with OpenTofu. Every push to main deploys.                                                          |
| Tiger Data                   | The database        | Managed PostgreSQL for orders, mandates and offers. Its hash-chained audit log shows if anyone edits the past.                                      |
| ElevenLabs                   | The agent's voice   | The chef talks and the agent answers aloud. Speech-to-text stays local. Approving is still a tap.                                                   |

Speaker notes: Nemotron runs the whole ordering chat in our Open WebUI: it reads an informal request and picks products, amounts and a date. Verda serves it. The server checks every choice, so a wrong pick by the model can't turn into an unchecked order. That's why an open model works here. What made it pass 7 of 7: the ordering skill in the prompt, a browser test with real chat sentences, a 16,384-token output limit, and tools that need less copying, like short offer IDs. Codex agents picked up GitHub issues and worked them in parallel, each in its own git worktree, and Codex also reviewed the code Claude wrote. The numbers come from our agent session logs. Tiger Data holds all nine bounded contexts. We don't use its time-series features. ElevenLabs (`eleven_multilingual_v2`) reads replies aloud in the hosted chat on the live demo. A person still approves with a tap, never by voice.

### Nemotron form text

The Nemotron challenge requires this explanation as text in the submission form:

```text
Model: NVIDIA Nemotron 3.5 Super VL (nemotron-3.5-super-vl), served by
Verda on a B300 GPU through an OpenAI-compatible endpoint.

What it does: Nemotron is the buyer's AI agent in our Open WebUI
workspace for a restaurant and a bakery. It turns a chef's spoken
sentence or a recipe plan into an order: it searches the wholesaler
catalogue with the buyer's constraints through our MCP tools, gets
signed offers, and places the order. When a rule stops the order, it
explains the reason and shows the approval card for a person.

Why it matters: kitchen staff order while their hands and attention are
busy. Nemotron reads the informal request and chooses products, amounts
and the delivery date. The wholesaler's server checks every choice
against the buyer's signed limits, so a wrong model choice cannot become
an unchecked order.

How we improved its outputs: we embedded our ordering skill and the
reason codes in the system prompt. A browser test sends the demo
sentences to the model and checks the tool calls, the stored order and
the reply. It showed that about 1 reply in 7 stopped inside the model's
reasoning. Raising the output limit from 4,096 to 16,384 tokens fixed
this: 7 of 7 scenarios passed twice in a row. We made the tools easier
for a model to use: short offer IDs instead of 1,350-character tokens,
server-made idempotency keys, and quiet tool versions. We also fixed the
prompt for wrong replies found in tests, for example never saying "Done"
while an order waits for a person.
```
