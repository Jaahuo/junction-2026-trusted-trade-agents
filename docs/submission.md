# Submission

Draft for the Junction 2026 submission of the Trusted trade agents project.
Final submission closes on Sunday, November 15, 2026 at 10:00 Helsinki time.
A person records the video, exports the deck and submits; this page holds the links and the material to prepare them.

## Links

Fill in each link before you submit.
Every link must open without a login.

| Item                       | Link                                                                   | Status                                       |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| Pitch video (2:00 at most) | TODO                                                                   | Not recorded                                 |
| Deck (PDF)                 | TODO                                                                   | Not exported                                 |
| Live demo                  | TODO: the hosted URL of #84, or a tunnel that stays up through judging | Not chosen                                   |
| Source code                | https://github.com/Jaahuo/junction-2026-trusted-trade-agents           | Private until #38 or #63 settles the dataset |

- Video length: TODO (for example `1:58`, stated with the file).
- Recorded build: TODO (the commit on `main` that the video shows).
- Submission receipt: paste it in #35 before 10:00.

## What is real and what is simulated

Say this in the video and on the last slide.

- Real: the product data, live availability and prices from the challenge's wholesaler mock, the signed offers, the mandate checks, the guardrails, the approval flow and the audit record.
- Simulated: one demo account and no authentication; anyone with the demo URL can open the approval page (SPEC-002).
- Simulated: the buyer's signing key is held by the server ("simulated custody", SPEC-008).
- Scenario 3 runs on live data with a lactose-free product that is not milk, because no lactose-free milk in the mock is short (#83).
- The missed cut-off clip is not available on live data: the mock gives the same first delivery date for every product (#83).

## Before recording

Follow `docs/demo-runbook.md` (#19). In short:

1. Run `bun run db:reset`.
2. Run `bun scripts/check-demo-data.ts --date <requestedDate>` and confirm S1, S2 and S3 print `ok`. If the mock's first delivery date has moved, update `requestedDate` in `data/demo-products.json` first.
3. Run `bun scripts/demo-smoke.ts --scenario 1` and `--scenario 2`.
4. Run `bun run build` so the `ui://` views render in the host.

## Video shot list

Total 2:00 at most, split by judging weight.

| Time      | Shot                       | Criterion                   | What the viewer sees                                                                                                                                                                                                         |
| --------- | -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00-0:10 | Problem                    | User need (20%)             | One sentence: kitchens want an agent to order for them, but not with unlimited authority, and wholesalers want to keep their own rules.                                                                                      |
| 0:10-0:35 | Scenario 1: small order    | End-to-end demo (30%)       | The buyer types or says a small lactose-free milk order. The agent searches, gets a signed offer and places it. The order is placed with no reasons, and the audit record is shown.                                          |
| 0:35-1:15 | Scenario 2: over the limit | Autonomy and controls (20%) | 1,000 litres of lactose-free milk by Monday. The order goes to approval with `SPEND_OVER_LIMIT`. The approval card or page opens, a person approves, and the order is placed. Point out that the model has no approval tool. |
| 1:15-1:45 | Scenario 3: short stock    | Exceptions (15%)            | A lactose-free product with stock below the request. The agent orders what is available and proposes the listed substitute; the order goes to approval with the shortfall and substitution reasons.                          |
| 1:45-2:00 | Open contract              | Openness (15%)              | `/.well-known/trusted-trade.json`, the OpenAPI document, and an offer verified with the public key from `/.well-known/jwks.json`. End on: "Any agent can call it, the wholesaler enforces the buyer's signed limits."        |

Optional, only if time allows: the rogue-agent pass of #19 acceptance 8, where a changed offer, a reused token and an expired offer each end with their reason code.

## Deck outline

One slide per judging criterion, then assumptions and next steps.

1. **Title.** Trusted trade agents: an open ordering endpoint that buyer agents can use and wholesalers can trust.
2. **User need (20%).** A food-service buyer orders from a notebook or memory, often hands-busy. Agents could order, but buyers will not hand them unlimited purchasing authority. Evidence: the buyer interview of November 14 (#44).
3. **End-to-end demo (30%).** One request goes through search, signed offer, mandate check and placed order, with the audit record. Show scenario 1 as a still or a short loop.
4. **Autonomy and controls (20%).** The buyer's signed mandate sets the limits, and the wholesaler enforces them along with its own guardrails. Over the limit, a person approves on the approval card; the model never sees an approval tool.
5. **Robustness to exceptions (15%).** Short stock with a substitute, an expired or changed offer, and the credit limit each end with a reason code a person can read.
6. **Openness and path to production (15%).** A discovery file, an OpenAPI document, an MCP endpoint and a skill, with offers any party can verify against the published keys. Wholesaler-specific code sits only in adapters, so another wholesaler plugs in through an adapter. Positioning line from the research note on #35: "Any agent can call it, the wholesaler enforces the buyer's signed limits, and the order maps to Peppol."
7. **Assumptions and next steps.** What is simulated (see the list above); next steps are accounts and the authorize flow (#34), pay-on-order, and a second adapter (#33).

Quote a mentor only with permission (#76).
