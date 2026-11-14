# Trusted Trade Agents: product requirements document

Owner: the whole team · Created: November 14, 2026 · Status: living draft

This PRD is the single source of product requirements. It describes intended behavior, not implementation status. Existing Decided choices remain the baseline; Proposed choices and open questions are not approved requirements.

References: [challenge brief](challenge.md), [supplied mock API specification](open_api.json) and [datasets](../README.md#challenge-data). The supplied mock API is not the product's planned REST contract.

We build an open ordering contract that lets any buyer's agent search, receive a signed offer and place an order with a wholesaler. The demo server signs the buyer's limits with a simulated buyer key and enforces them on every order. Valio Aimo's mock backend is the first implementation.

## Problem and goal

Food-service buyers need agents to find and order suitable products without giving them unrestricted purchasing authority. Wholesalers need to enforce their own rules without exposing their internal systems.

The product lets a buyer's agent complete a structured lookup-to-order flow. The server enforces the buyer's mandate and the wholesaler's guardrails. A human decides exceptions, and the audit record explains each outcome.

## Document boundaries and change rules

Keep product documentation in at most three working files. Start with this PRD alone.

- `docs/prd.md`: owns scope, user-visible behavior, acceptance criteria and unresolved product questions. Keep the detailed contract examples here until a spec needs to own them.
- `docs/specs.md`: create only when an implementation needs detail that the PRD cannot express clearly. Use numbered sections such as `SPEC-001`, not a file per feature. Each section links to its PRD requirement heading and defines the contract, failure paths and verification. Move the detail here; do not copy it.
- `docs/adrs.md`: create only for a consequential architecture choice with credible alternatives, such as a trust boundary, persistent data model or external contract. Use numbered entries such as `ADR-001`, not a file per decision. Record status, context, decision, alternatives and consequences. Link to the affected PRD or spec section.

These boundaries apply to product planning. Existing runtime, workflow and source-reference documents keep their separate purpose.

1. Before changing scope or behavior, identify the affected PRD heading. Resolve any proposal, contradiction or open question that blocks that change with the team. Do not silently treat a draft as decided.
2. Update the affected PRD text, any existing spec and the implementation in the same PR. A planning-only PR may change intended behavior first, but must state that implementation is pending.
3. Add or update an ADR only when its decision threshold applies. Preserve accepted decision reasoning; record a replacement entry and mark the previous entry superseded when the decision changes.
4. Keep one owner for each fact. The PRD owns what and why; specs own implementation detail; ADRs own decision rationale. Link instead of repeating. An implementation detail cannot override a product requirement.
5. Each behavior-changing PR states the changed requirement, observable acceptance result and actual verification evidence. A code-only refactor needs no document edit if the contract and architecture decision remain unchanged.
6. Before merge, check that affected requirements, contracts, decisions and tests agree. Resolve conflicts rather than choosing a convenient source. Keep section IDs stable; use Git and PR history instead of a separate change log.

## Acceptance and evidence

The [demo scenarios](#scenarios) define the observable end-to-end outcomes. Completion requires recorded results, not just completion of the [build order](#build-order).

- Demonstrate automatic placement, human approval and the partial-stock/substitution flow against the mock backend.
- Exercise the [role boundaries](#roles-and-access): through the MCP tools, the model cannot approve an order or change a mandate. The first build has no authentication, so the REST API is open; the full role boundary arrives with accounts.
- Verify the rejection and forced-approval paths in [rules and decisions](#rules-and-decisions), including invalid offers and fixed guardrails that human approval cannot bypass.
- Verify the [order exceptions](#order-states-and-exceptions), including expiry, changed offers and limits applied to the whole order.
- Verify that REST and MCP expose the same contract and that structured results work without MCP Apps. Record actual host support rather than assuming it.

An unresolved product choice blocks acceptance of the affected behavior, not unrelated work. Issues and PRs track delivery and evidence; this PRD does not track task status.

## Scope

One service sits in front of a wholesaler's existing systems and adds the order step, the rules and the record. For Junction it runs against Valio Aimo's mock, which offers price and availability lookups but no order endpoint.

**In scope**

- Structured product search over the static product file
- Signed offers built from live price and availability
- Orders checked against the buyer's mandate and the wholesaler's fixed guardrails
- Human approval, with a reason code on every request
- A readable audit record per order
- A REST API and an MCP server, with MCP Apps views and one Skill

**Out of scope**

- Payment processing. Payment terms are a field on the order, and pay-on-order authorization is simulated.
- Agent-to-agent negotiation. Prices are fixed.
- A shop UI or a marketplace
- Free-text parsing on the server

**Choices so far**

| Topic                       | Choice                                                                                                                                                          | Status   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Interface                   | REST API with an MCP server on top                                                                                                                              | Decided  |
| MCP extensions              | Apps for user-facing views, Skills so any agent can run the flow                                                                                                | Decided  |
| Demo host                   | Open WebUI with voice is the main demo host. Approval uses the in-chat card; the approval page on a phone is the fallback (#44). A custom agent UI comes later. | Decided  |
| Search input                | Structured fields only. The host agent turns the sentence into fields.                                                                                          | Decided  |
| Mandate                     | AP2-style, registered and stored on the wholesaler's server. The demo simulates buyer signing with a server-held key; buyer-side custody comes next.            | Decided  |
| Signing                     | Real signed JWTs                                                                                                                                                | Decided  |
| Authentication              | None in the first build: one demo account, the invoice customer. A second account, an account picker and the MCP authorization step come later.                 | Decided  |
| Missing product data        | Goes to approval. Users may opt to auto-approve for reliability, CO2 and allergen data.                                                                         | Decided  |
| Offer expires while pending | Auto re-quote. Ask again on a price rise, an availability change or a rule break.                                                                               | Decided  |
| Second wholesaler adapter   | Only if time remains                                                                                                                                            | Decided  |
| Mandate build order         | The demo registers JSON and signs it on the server; buyer-side signing and key custody come next.                                                               | Decided  |
| Allergen data               | Missing allergen data goes to approval unless the mandate sets allergen data to auto.                                                                           | Decided  |
| Naming                      | Nothing in the spec or tool names mentions Valio or Aimo. Only the adapter does.                                                                                | Decided  |
| Demo exception              | Partial stock and substitution chained in one request, on real mock data. If no product fits, the missed cut-off clip replaces it.                              | Decided  |
| Public URL                  | Hosted demo at https://199-247-4-99.sslip.io on Vultr and Tiger Data (#37, #84).                                                                                | Decided  |
| Order store                 | Our own store; the mock has no order endpoint                                                                                                                   | Decided  |
| Offer input                 | `place_order` takes the signed offer tokens                                                                                                                     | Decided  |
| Reject                      | Two actions: reject and stop, reject and allow alternatives                                                                                                     | Decided  |
| Unconfirmed stock           | Large orders of unconfirmed-stock products need approval                                                                                                        | Decided  |
| Buyer limits                | The wholesaler uses them only for enforcement                                                                                                                   | Decided  |
| Approval                    | Human only, on the approval card or the approval page; no decision tool is visible to the model                                                                 | Decided  |
| Views                       | All five, in priority order: approval card, offer comparison, order timeline, search results, mandate settings                                                  | Decided  |
| Hard constraints            | Every GS1 allergen code and free-from claim in the product data, and vegan. `MAY_CONTAIN` counts as contradicted.                                               | Proposed |
| Agent rationale             | The agent may send a `purpose` and a `rationale` per line. The server stores them and shows them on the card and in the audit record. It never parses them.     | Proposed |
| Trust chain                 | The views and an independent script verify offer signatures against the published keys. A placed order gets a signed receipt. The audit record is hash-chained. | Proposed |
| Attack demo                 | A chat jailbreak and a rogue-agent script show the guardrails holding. The demo shows only attacks that the first build stops.                                  | Proposed |
| Approval page design        | The page embeds the same card as the chat view, mobile-first. The web app uses the view palette. Each reason code has one plain-words sentence.                 | Proposed |
| Spend across orders         | The spend limit applies per order. A rolling budget across orders comes only if time remains.                                                                   | Proposed |

## Flow at a glance

A failed fixed guardrail rejects the order, a buyer limit set to ask sends it to approval, and everything else is placed. If an offer expires while its order waits, the server re-quotes it. Pay-on-order orders pass through an awaiting-payment step before they are placed.

## Roles and access

Three roles exist. Through the MCP tools, the agent can never approve its own order; the full role boundary arrives with accounts. Every rule check runs on the wholesaler's server.

| Role          | Who                                                                                                                                           | Can do                                                                                      | Cannot do                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Buyer's agent | Any AI agent. The first build has no authentication: every request acts as the single demo account. An agent key arrives with accounts later. | Search, request offers, place orders, read order status, read its own mandate               | Approve, edit the mandate                |
| Approver      | A human at the buyer, such as a purchasing manager                                                                                            | Register the mandate, approve, reject or edit pending orders; buyer-side signing comes next | Change the wholesaler's fixed guardrails |
| Wholesaler    | The operator of the server                                                                                                                    | Set fixed guardrails, sign offers, read the audit record                                    | Change the buyer's mandate               |

**Demo access**

- The first build has one seeded demo account: the invoice customer with a credit limit and one agent.
- It has no authentication on REST or MCP. Every request acts as the demo account.
- Approver actions are tools that only a view calls. The model does not see them, so the agent cannot approve. A person approves on the approval card or the approval page.
- Anyone who reaches the demo URL can open the approval page and call the REST API, including decisions. The README says so.
- Later: a pay-on-order account, an account picker and the MCP authorization step (OAuth, as MCP specifies).
- Known gap: hiding the approver tools stops the model, not the client. Any MCP client or REST caller can call the decision action and approve its own order. The demo does not show this attack.
- Production path: a decision needs the approver's own authentication, separate from the agent's credentials, for example passkey re-authentication or OpenID CIBA, where the agent's request makes the approver confirm on their own device.

## Tools

Ten tools cover the flow: seven the model can call and three that only a view calls. Each tool is also a REST endpoint with the same JSON Schema, published as an OpenAPI document.

| Tool                     | Caller            | Input                                                                                                                                                  | Returns                                                                                                          |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `search_products`        | Agent             | Structured need: terms, hard and soft constraints, quantity with unit, deliver-by date                                                                 | Candidate products with a per-constraint match and the quantity converted to sales units. Uses static data only. |
| `get_offers`             | Agent             | Product IDs, quantities, deliver-by date, payment terms                                                                                                | One signed offer per product, each with a pre-check result                                                       |
| `place_order`            | Agent             | One or more signed offer tokens, optional alternative offer tokens, optional original request text, idempotency key                                    | Order with status: placed, pending approval or rejected, plus reason codes                                       |
| `get_order_status`       | Agent             | Order ID                                                                                                                                               | Current status and the audit record                                                                              |
| `get_mandate`            | Agent             | None                                                                                                                                                   | The limits currently in force for this agent                                                                     |
| `draft_mandate`          | Agent             | Proposed limits and standing constraints, from the terms the human gave                                                                                | The draft next to the current limits. Nothing is registered: the human registers it in the mandate view          |
| `register_mandate`       | Approver          | The mandate as JSON; the demo server signs it with the simulated buyer key                                                                             | Mandate ID. The previous mandate is revoked.                                                                     |
| `revoke_mandate`         | Approver          | Mandate ID                                                                                                                                             | Confirmation                                                                                                     |
| `list_pending_approvals` | Agent or approver | None                                                                                                                                                   | Orders waiting for a decision                                                                                    |
| `decide_approval`        | Approver          | Order ID, proposal version and a decision: approve, reject and stop, reject and allow alternatives, edit, pick an alternative, or approve and remember | Updated order                                                                                                    |

**Notes**

- `search_products` makes no live calls. `get_offers` is the only tool that calls the wholesaler's price and availability systems, and only for the shortlist.
- The pre-check on an offer is guidance. `place_order` runs the checks again, because an offer can go stale.
- The wholesaler's fixed guardrails, supported payment terms and public signing keys are published as a readable resource, so an agent knows the rules before ordering.

## Data objects

Four objects carry the flow: the search request, the signed offer, the mandate and the order. All values below are illustrative.

The exact shapes are in [specs](specs.md); the examples below are illustrative.

### Search request

The host agent fills these fields from the user's sentence. A hard constraint that a product contradicts excludes the product, and one with missing data sends the order to approval. Soft constraints only affect ranking. Standing constraints from the mandate are added by the server. Hard constraints are the GS1 allergens and free-from claims in the product data, such as gluten-free or egg-free, and vegan. A request with any other hard constraint is refused.

```json
{
  "terms": ["milk"],
  "hard": [{ "attribute": "lactose", "is": "free_from" }],
  "soft": [{ "attribute": "countryOfOrigin", "prefer": "fi" }],
  "quantity": { "value": 1000, "unit": "LTR" },
  "deliverBy": "2026-11-16",
  "paymentTerms": "invoice",
  "originalRequest": "I need 1,000 litres of lactose-free milk by Monday."
}
```

Each candidate in the result states how it matched and what to order:

```json
{
  "productId": "460013",
  "match": { "lactose": "confirmed" },
  "orderQuantity": { "value": 100, "unit": "KI" },
  "equals": { "value": 1000, "unit": "LTR" },
  "deliveryReliability": 0.995,
  "co2PerKg": 1.44
}
```

- A match is `confirmed`, `contradicted` or `unknown`. Missing data is never treated as confirmed.
- Quantity conversion: volume of the consumer unit, times units per sales unit, rounded up to the allowed lot size.
- Standard units use the codes already in the product data (LTR, KGM). The sales unit is the wholesaler's own code, so every result also states the standard-unit equivalent.

### Signed offer

The offer is the wholesaler's binding promise, issued as a signed JWT. Any agent can verify it with the wholesaler's published public key.

```json
{
  "iss": "https://wholesaler.example",
  "offerId": "off_8f2c",
  "customer": "cust_invoice_01",
  "productId": "460013",
  "quantity": { "value": 100, "unit": "KI" },
  "unitPrice": { "net": 9.8, "vatRate": 13.5, "currency": "EUR" },
  "deposits": 0,
  "total": { "net": 980.0, "gross": 1112.3 },
  "deliveryDate": "2026-11-16",
  "stock": "confirmed",
  "paymentTerms": "invoice",
  "iat": 1794650000,
  "exp": 1794664800
}
```

- `exp` is the offer's time to live: the earlier of the price's validity end and the order cut-off.
- `stock` is `confirmed` when the wholesaler knows the quantity and `unconfirmed` when the product ships from a supplier's warehouse.
- The total includes VAT and deposits, because the spend limit is checked against the full amount.
- The pre-check travels beside the signed offer, not inside it, since it depends on the mandate: `{ "decision": "needs_approval", "reasons": ["SPEND_OVER_LIMIT"] }`.

### Mandate

The mandate is the buyer's permission for one agent, in the style of AP2. The approver registers it, and the demo server signs it with a server-held buyer key. The server uses the stored mandate to check the agent. It does not verify the mandate signature during order checks yet (#123).

```json
{
  "iss": "cust_invoice_01",
  "mandateId": "man_31a7",
  "agent": "agent_key_abc",
  "signedBy": "approver_01",
  "limits": {
    "maxOrderTotal": { "value": 1000, "currency": "EUR", "basis": "gross" },
    "categories": ["<category code>"],
    "substitutions": "ask",
    "newProducts": "ask",
    "minDeliveryReliability": { "value": 0.95, "ifNoData": "ask" },
    "maxCo2PerKg": { "value": 3.0, "ifNoData": "auto" },
    "paymentTerms": { "invoice": "auto", "pay_on_order": "ask" }
  },
  "standingConstraints": {
    "hard": [],
    "soft": [{ "attribute": "countryOfOrigin", "prefer": "fi" }]
  },
  "iat": 1794600000,
  "exp": 1798761600
}
```

- Each limit resolves to `auto` (the agent may proceed) or `ask` (send to approval).
- `ifNoData` is the user's choice for reliability, CO2 and allergen data.
- Changing a limit means registering a new mandate, which the demo server signs. Every order records the mandate ID it was checked against.
- The first build takes mandate data as JSON and simulates buyer-key custody on the server. Buyer-side signing and key custody come next.
- The wholesaler uses the stored limits only to enforce them, in no other form. Demo users can change every limit.

### Order

```json
{
  "orderId": "ord_5d90",
  "offerIds": ["off_8f2c"],
  "mandateId": "man_31a7",
  "status": "pending_approval",
  "reasons": ["SPEND_OVER_LIMIT"],
  "approvalUrl": "https://wholesaler.example/approvals/ord_5d90",
  "paymentTerms": "invoice",
  "audit": [
    { "at": "2026-11-14T10:02:11+02:00", "actor": "agent", "event": "order_requested" },
    {
      "at": "2026-11-14T10:02:11+02:00",
      "actor": "server",
      "event": "check_failed",
      "rule": "maxOrderTotal",
      "detail": "1112.30 EUR is over the 1000 EUR limit"
    }
  ]
}
```

The order records the offer and mandate by reference. The demo server signs both, but does not verify the mandate signature during order checks yet (#123). The audit record is written by the server as each step runs.

## Rules and decisions

Every order request ends as placed, pending approval or rejected, or is refused with an error code before an order exists (an invalid or repeated offer token, mixed payment terms, a stale offer). The server decides with plain rule checks, and no model is involved in this step.

**Check order**

1. Identify the agent (the demo account in the first build) and load its registered mandate.
2. Verify the offer's signature and expiry.
3. Apply the wholesaler's fixed guardrails. A hard failure rejects the order.
4. Apply the buyer's limits. Any limit that resolves to `ask` sends the order to approval, with every reason listed.
5. Otherwise place the order.

### Wholesaler's fixed guardrails

The buyer cannot switch these off. Buyers can set tighter limits in their mandate, but never looser ones.

| Guardrail           | Check                                                                                      | On failure                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Authentication      | Valid agent key (none in the first build) and a registered, unexpired mandate              | Rejected                                                                                                               |
| Offer validity      | Signature verifies and the offer has not expired                                           | A bad signature refuses the request and stores no order. An expired offer is rejected. The agent requests a new offer. |
| Credit limit        | Invoice terms only: the total fits the remaining credit                                    | Rejected                                                                                                               |
| Payment             | Pay-on-order only: the simulated authorization succeeds                                    | Rejected                                                                                                               |
| Delivery cut-off    | The order arrives before the closing time for that delivery date                           | Rejected, with the next available date                                                                                 |
| Sales block         | The product is not blocked for ordering                                                    | Rejected                                                                                                               |
| Quantity sanity cap | Quantity is under 10 times the usual amount, or under a fixed cap when there is no history | Forced approval                                                                                                        |
| Unconfirmed stock   | Unconfirmed stock per product is at most 500 standard units                                | Forced approval                                                                                                        |

### Buyer's limits

The approver sets these in the mandate.

| Limit                        | Meaning                                                        | Data and gaps                                                                                |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Spend per order              | Gross total, with VAT and deposits, stays under the maximum    | Offer total. Variable-weight products need a tolerance.                                      |
| Allowed categories           | The agent may only order from listed categories                | Category codes come without names, so the settings view needs labels.                        |
| Substitution policy          | Never, ask or auto, plus per-pair rules from the approval card | The substitution pairs in the product data                                                   |
| New products                 | A product the customer has not ordered before needs approval   | Needs seeded order history in the mock                                                       |
| Minimum delivery reliability | The product's score must meet the minimum                      | Scores exist for 4,425 products. No data means ask, unless the user chose auto.              |
| Maximum CO2 per kg           | The product's footprint must be under the maximum              | Category-level estimates for 11,033 products. No data means ask, unless the user chose auto. |
| Allergen data                | A hard allergen constraint has data for the product            | No data means ask, unless the user chose auto.                                               |
| Payment terms                | Which terms the agent may use alone                            | Invoice or pay-on-order                                                                      |

Known gap: the spend limit applies to one order. An agent can split one purchase into several orders that each pass it. A rolling budget across orders is the Proposed fix, built only if time remains.

### Reason codes

The list is fixed and part of the open contract, so any agent can act on a result without reading free text.

| Code                    | Result   | Meaning                                                                                   |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `SPEND_OVER_LIMIT`      | Approval | Total exceeds the mandate's spend limit                                                   |
| `CATEGORY_NOT_ALLOWED`  | Approval | Product is outside the allowed categories                                                 |
| `SUBSTITUTION`          | Approval | The line is a substitute for the requested product                                        |
| `NEW_PRODUCT`           | Approval | Not in the customer's order history                                                       |
| `RELIABILITY_BELOW_MIN` | Approval | Delivery reliability is under the minimum                                                 |
| `CO2_ABOVE_MAX`         | Approval | Footprint is over the maximum                                                             |
| `UNCONFIRMED_DATA`      | Approval | Reliability or CO2 data is missing and the user chose ask                                 |
| `UNCONFIRMED_ALLERGEN`  | Approval | A hard allergen constraint has no data and the mandate says ask                           |
| `QUANTITY_UNUSUAL`      | Approval | Quantity is over the sanity cap                                                           |
| `PAYMENT_TERMS`         | Approval | The mandate requires sign-off for these terms                                             |
| `PRICE_CHANGED`         | Approval | A re-quote came back at a higher price                                                    |
| `UNCONFIRMED_STOCK`     | Approval | Stock is unconfirmed and the product total is over the unconfirmed-stock cap              |
| `AVAILABILITY_DIFFERS`  | Approval | Delivery is later than requested or the amount is smaller, on a first offer or a re-quote |
| `NOT_AUTHENTICATED`     | Rejected | Unknown agent key. Not produced while the demo has no authentication.                     |
| `MANDATE_INVALID`       | Rejected | No mandate, or it is expired or revoked                                                   |
| `OFFER_INVALID`         | Refused  | The signature does not verify. The request fails and no order is stored.                  |
| `OFFER_EXPIRED`         | Rejected | The offer's time to live has passed                                                       |
| `CREDIT_LIMIT`          | Rejected | Total exceeds the remaining credit                                                        |
| `PAYMENT_FAILED`        | Rejected | Pay-on-order authorization failed                                                         |
| `CUTOFF_PASSED`         | Rejected | Closing time for the delivery date has passed                                             |
| `SALES_BLOCKED`         | Rejected | The product cannot be ordered now                                                         |

## Order states and exceptions

An order is always in one of five states, and each exception below has one defined handling.

| State            | Meaning                                                             | Moves to                                                                                                            |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Pending approval | Waiting for the approver's decision                                 | Placed, declined, awaiting payment, or rejected (the mandate became invalid, or the credit limit fails at approval) |
| Awaiting payment | Pay-on-order only: waiting for the simulated authorization          | Placed or rejected                                                                                                  |
| Placed           | Committed at the offer's price and delivery date                    | Final                                                                                                               |
| Rejected         | A fixed guardrail failed                                            | Final. The agent may start a new request.                                                                           |
| Declined         | The approver said no, or gave no answer before the delivery cut-off | Final. The order states whether the agent stops or may look for alternatives.                                       |

Orders live in our own store, because the mock has no order endpoint.

### Offer expires while the order waits

1. The server re-quotes the same product, quantity and date.
2. If the price is the same or lower, the date and amount hold, and no rule now breaks, the new offer replaces the old one. The approver is not asked again.
3. Otherwise the new reason is added, and the approval card shows the old and new values side by side.
4. Every re-quote is written to the audit record.

### Partial stock

- This applies when the wholesaler knows the stock and it is less than the request.
- `get_offers` returns an offer for the available amount and states the shortfall in standard units.
- The agent covers the shortfall with a substitute or a later delivery, each as its own offer.
- An order may hold several offer lines. Limits apply to the order total, so splitting cannot bypass a limit.
- When stock is unconfirmed, the offer says so and shows the product's delivery reliability score.

### Delivery later than requested

- Availability returns the earliest possible date. If it is after the deliver-by date, the offer carries the real date and its pre-check lists `AVAILABILITY_DIFFERS`.
- The agent can look for an alternative that arrives on time, or order the late offer, which goes to approval.
- If the closing time passes between offer and order, the order is rejected with `CUTOFF_PASSED` and the next available date.

### Substitution

- Candidates come from the wholesaler's own substitution pairs for the product.
- Hard constraints still apply. A contradicted constraint excludes the substitute, and unknown allergen data goes to approval unless the mandate allows auto-approval for missing allergen data.
- Candidates are ranked good, better, best on soft constraints, price per litre or kilogram, delivery reliability and CO2.
- The mandate's substitution policy decides the result: never means not offered, ask means approval with `SUBSTITUTION`, auto means placed if every other check passes.
- Each substitute offer names the product it replaces and states the differences in price, origin and reliability.
- Trust grows from the human's decisions, with nothing to type. After the human approves the same substitute 3 times, the card asks "Let the agent do this without asking?". Yes saves an auto rule for that pair: later orders skip `SUBSTITUTION` for it, and every other check still applies. After a rejection, the card asks whether the agent should keep suggesting that substitute; **Don't suggest again** saves a never rule: the agent is not offered that substitute again. The human removes either rule in the mandate view.

### Products that cannot be offered

A product with no price, a sales block or no delivery date is left out of the offers, with the reason stated in the response.

## Approval and user-facing views

Approval happens in the chat when a human is present, and on a web page when the agent runs unattended. The card in the chat and the approval page show the same information and call the same decision action.

### Approval card

The card shows the original request, the proposed order lines, the rules that fired in plain words, and the alternatives.

| Action                               | Effect                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Approve                              | The order is placed at the offer's terms, or moves to awaiting payment                              |
| Reject and stop                      | The order is declined; the agent stops and tells the user                                           |
| Reject, allow alternatives           | The order is declined; the agent may look for alternatives                                          |
| Change quantity or delivery date     | A new signed offer is issued and every check runs again                                             |
| Pick a different offered alternative | Same as above, on the chosen offer                                                                  |
| Approve and remember                 | Pricing only: the approver registers a new mandate with the raised limit, signed by the demo server |

An edit can never bypass a guardrail, because it always produces a new offer and a new check. Build approve and reject first.

### Views

Each view is an MCP App: a tool declares a `ui://` resource, and the host renders it in a sandboxed frame inside the conversation.

| Priority | View             | Attached to                                          | Shows                                                                                                |
| -------- | ---------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1        | Approval card    | `place_order` when pending, `list_pending_approvals` | The card described above                                                                             |
| 2        | Offer comparison | `get_offers`                                         | Options side by side: price per litre or kilogram, delivery date, reliability, CO2, pre-check result |
| 3        | Order timeline   | `get_order_status`                                   | The audit record in readable form                                                                    |
| 4        | Search results   | `search_products`                                    | Candidates, how each matched, and the quantity to order                                              |
| 5        | Mandate settings | `get_mandate`, `draft_mandate`                       | The limits in force, or the agent's draft with a Register button for the human                       |

- Tools always return structured data and text as well, so hosts without MCP Apps still complete the flow.
- The card in the chat and the approval page show the same information and call the same decision action. An order pending approval returns its `approvalUrl`, the address of the approval page.
- Approver actions are tools that only a view calls; the model does not see them. If a host cannot hide them, no decision tool is registered and the card links to the approval page.

### Skill

One skill teaches any agent the flow. It is served through the MCP Skills extension as a `SKILL.md` with reference files.

- The steps: read the mandate, search, request offers, prefer an offer whose pre-check is auto, place the order.
- What to do on each result: tell the user and stop on pending approval, read the reason code on a rejection.
- How to state quantities and units.
- A reference file with the reason codes.
- One rule of conduct: never reshape an order to get around a limit.

The skill is guidance and the server is the control. Host support for Skills over MCP is still early, so the same file also lives in the repository and the tool descriptions must be enough on their own.

## Open contract and adapters

The contract is vendor-neutral and each wholesaler hosts its own endpoint, with nobody in the middle. Only the adapter knows about Valio Aimo.

| Layer            | Contains                                                                                                            | Specific to a wholesaler |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Contract         | JSON Schemas for search, offer, mandate and order, the order states, the reason codes, the tool names and the skill | No                       |
| Reference server | Rule checks, signing, order store, audit record, REST and MCP bindings, views                                       | No                       |
| Adapter          | Five functions against the wholesaler's own systems                                                                 | Yes                      |

**Principles**

- The contract is defined in JSON Schema and OpenAPI first. REST and MCP are two bindings of the same shapes.
- Discovery is a file on the wholesaler's own domain, listing the endpoint, public signing keys, fixed guardrails and payment terms.
- Products use the wholesaler's product ID; GTIN is included when available. Producer identifiers are not exposed. Quantities use standard unit codes where applicable.
- The catalogue, customer prices and guardrail values stay on the wholesaler's server.
- The mandate is AP2-style. We borrow the shape and do not claim AP2 compliance.

### Adapter for the Valio Aimo mock

| Adapter function  | Source                                                 | What it gives                                                                                      |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `searchCatalog`   | Product data file, downloaded once and indexed locally | Names in Finnish, Swedish and English, allergen classifications, packaging, origin, GTINs          |
| `getPrices`       | `POST /api/price`, up to 1,000 product IDs             | Price per sales unit with VAT, comparison price per litre or kilogram, validity period, error flag |
| `getAvailability` | `POST /api/availability`, up to 1,000 product IDs      | Earliest delivery date, amount in sales units, closing time, sales block, stock model              |
| `getSubstitutes`  | Substitution pairs in the product file                 | Allowed replacements per product                                                                   |
| `submitOrder`     | None in the mock                                       | Writes to our own order store                                                                      |

- Delivery reliability and CO2 come from two CSV files, joined on product ID.
- All calls send the API key in the `X-API-Key` header.
- Assumption: Valio Aimo's production API authenticates clients with OAuth2. We do not build that flow because it is out of scope and not relevant to the demo; a production adapter would replace the API key with an OAuth2 access token.
- Never query all products. Filter on static data first, then send the shortlist in one call. Rate limits are undisclosed, so cache results within their validity.
- Products shipped from a supplier's warehouse always report an amount of 999999, which means the stock is unconfirmed.
- The mock ignores the customer number. Customer-specific limits and terms are simulated in our layer, and the README says so.

### Known data gaps

- Unit, category and temperature codes come without names.
- Manufacturer fields are optional, so a product's volume can be missing. Dividing the catalogue price by the comparison price should give litres per sales unit. Verify this on a few products first.
- Reliability and CO2 cover only part of the catalogue, and 3,123 products have both.
- There is no order history, so the new-product rule and the quantity cap need seeded data.

A second adapter over a small JSON catalogue would prove the contract is portable. It is built only if time remains.

## Demo and build order

The demo runs three requests, each from one typed sentence, and steps 1 to 5 below are enough to show the first two. Final submission closes on Nov 15, 2026 at 10:00, and the pitch video may not exceed 2 minutes.

Judging weights: working end-to-end demo 30%, solving the user's need 20%, autonomy and controls 20%, robustness to exceptions 15%, openness 15%.

### Scenarios

| Scenario                                    | What happens                                                                                                                                                                                                                                                     | Criterion it shows    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| A small order within the limits             | Placed automatically, and the audit record is shown                                                                                                                                                                                                              | End-to-end flow       |
| 1,000 litres of lactose-free milk by Monday | The total is over the spend limit. The approval card appears, the approver approves, the order is placed.                                                                                                                                                        | Autonomy and controls |
| The same request when stock is short        | The agent orders the available amount and proposes a substitute for the rest. The shortfall and the substitute both raise reasons, so the order goes to approval as a whole. If the mock has no fitting product, the missed cut-off clip replaces this scenario. | Exceptions            |

A missed cut-off with a later delivery date is the backup clip.

Proposed: a rogue-agent clip after the scenarios. A chat jailbreak asks the agent to ignore its limits, and the order still goes to approval. A script then sends a changed offer, a reused offer token, an expired offer, an order over the credit limit and an order past the cut-off, and each ends with its reason code. Self-approval and order splitting stay out, because the first build does not stop them.

The mock returns real dates. The demo sentence must name a deliver-by date after the run day, before that date's cut-off.

**Find real products in the mock before scripting**

- [ ] A lactose-free milk with confirmed stock that covers the request
- [ ] A product with confirmed stock below the request
- [ ] A product with a listed substitute
- [ ] A product whose earliest delivery date is after Monday

### Build order

1. Product index, quantity conversion and `search_products`
2. `get_offers` with live price and availability, returned as a signed offer
3. Stored mandate with the spend limit and substitution policy, `place_order`, order store and audit record
4. MCP server with the six model tools, running in the first test host over a public HTTPS address
5. Approval page with approve and reject
6. Partial stock and substitution handling for the third scenario
7. README, OpenAPI document and discovery file
8. Approval card as an MCP App, and the skill
9. Mandate signature and `register_mandate`
10. Re-quote on expiry and the remaining limits
11. Other views, approver edits, approve and remember
12. Second adapter

Submission also needs demo and source links and a pitch deck PDF. All code is written at the event and published under the MIT license.

## Open questions

These points still need a team decision, a mentor answer or a check.

**For the team**

- [x] After the approver rejects, does the agent stop or look for alternatives? Two actions: reject and stop, reject and allow alternatives.
- [x] Does the quantity sanity cap force approval, as written here, or reject outright? Forced approval.
- [x] Should large orders of unconfirmed-stock products need approval? Yes, `UNCONFIRMED_STOCK`.
- [x] Which host runs the demo? Open WebUI with voice is the main host. Approval uses the in-chat card, with the approval page on a phone as fallback (#44).
- [x] Is a README note enough for the fact that the wholesaler sees the buyer's limits? Yes. The wholesaler uses the limits only to enforce them.
- [ ] The live mock had no short-stock or late product in the first search. Where does scenario 3 get its data: a wider live search (zero stock, or an order larger than the stock), the disclosed fixture mode `WHOLESALER_LIVE=fixture`, or no scenario 3?
- [ ] Do the team agree to the Proposed rows in "Choices so far"?

**For the mentors**

- [x] Should orders end in our own order store, or go through the webshop test accounts once they arrive? Our own store.
- [ ] How do credit limits and pay-on-order work for real customers, so the mock matches?
- [ ] May an offer show the exact available stock amount, or is that confidential? A partial-stock offer exposes it today.
- [ ] Which substitutions do customers accept without asking, and what spend limit does a real customer set?
- [ ] Who would hold and rotate the offer signing key, and does OpenID CIBA fit the identity setup for approver authentication?

**To verify**

- [x] Which classification codes mark a product as lactose-free in the product file? `nutritionalClaim` `FREE_FROM_LACTOSE`.
- [ ] Do the approval card and the skill load in the chosen host, and can a tool be hidden from the model?
