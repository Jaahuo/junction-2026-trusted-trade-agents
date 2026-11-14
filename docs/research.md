# Research: similar solutions and standards

Desk research from November 14, 2026.
This is a source reference, not a product requirement.
The [PRD](prd.md) owns scope and behavior; adopting a finding below follows [team rules](team-rules.md) R-12 and R-13.

Most product claims come from vendor pages, press releases and trade press dated 2025 to 2026, not from product documentation.
Rows marked _unverified_ rest on secondary sources only.
The findings were not cross-checked by a second reviewer.

## Bottom line

No food-service wholesaler, procurement suite or open protocol offers a supplier-hosted, open ordering endpoint that any buyer's agent can use under a buyer-signed mandate with B2B semantics.
Open protocols (UCP, ACP, AP2) target consumer checkout.
Procurement suites put the agent on the buyer side and reach suppliers through portals or email.
Food-service AI (Choco, Pepper, REKKI) turns human orders into ERP orders on the supplier side and is closed.
The project's differentiation is B2B semantics and seller-side mandate enforcement with escalation to a human, not the cryptography, so the contract should reuse existing field names and conventions.

| Position              | Open standard                                                   | Closed product                                                             |
| --------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Supplier hosts agents | UCP and ACP (retail checkout); Peppol, UBL, cXML (no agent API) | Choco, Pepper, REKKI, Cut+Dry, Sysco, US Foods, Salesforce B2B Buyer Agent |
| Buyer hosts agents    | AP2 mandates; Instacart Developer Platform                      | SAP Ariba, Coupa, Zip, Amazon Business, Pactum, MarketMan, Galley          |

This project sits in the empty cell: supplier-hosted, open and B2B.

## Reuse map

| Contract piece              | Reuse                                                                                                       | Source                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Discovery file              | UCP profile at `/.well-known/ucp` with services, capabilities and `keys[]` JWKs addressed by `kid`          | [UCP](https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/)                                        |
| Signed discovery            | A2A signs its Agent Card at `/.well-known/agent-card.json`                                                  | [A2A](https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html)           |
| Signed offer                | UCP merchant-signed checkout: detached JWS, ES256, JSON canonicalized with JCS (RFC 8785)                   | [UCP AP2 extension](https://ucp.dev/latest/specification/payment/extensions/ap2-mandates/)                                      |
| Mandate                     | AP2 open mandate (constraints and budget) checked against a closed mandate (final cart and amount)          | [AP2](https://ap2-protocol.org/)                                                                                                |
| Human escalation            | UCP `requires_escalation` status with `continue_url`; the MCP Apps card is the in-chat version              | [UCP checkout](https://ucp.dev/latest/specification/checkout/)                                                                  |
| Approval card               | MCP Apps: `ui://` resources with `text/html;profile=mcp-app`, linked from tools via `_meta`                 | [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)                              |
| Order and line status       | Peppol and UBL order response codes AB (received), AP (accepted), RE (rejected), CA (accepted with changes) | [Peppol OrderResponse](https://docs.peppol.eu/poacc/upgrade-3/syntax/OrderResponse/cac-OrderLine/cac-SellerSubstitutedLineItem) |
| Substitution on a line      | UBL `cac:SellerSubstitutedLineItem`                                                                         | Same as above                                                                                                                   |
| Partial stock               | cXML confirmation with a backordered split quantity and date                                                | [cXML ConfirmationRequest](https://punchoutcommerce.com/guides/transactions/cxml-confirmation-request)                          |
| Product identity, allergens | GTIN, GS1 Digital Link, GS1 GDSN allergen and ingredient attributes (EU 1169/2011 data)                     | [GS1 foodservice](https://discover.gs1.org/foodservice/fragments/restaurant/additional-product-info-standards-in-action/)       |
| Agent identity (later)      | Web Bot Auth: RFC 9421 signatures, `Signature-Agent` header, JWKS directory under `/.well-known/`           | [IETF draft](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html)                                    |
| Bounded authority           | ACP delegated payment token with a maximum amount and an expiry                                             | [ACP](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)                                                   |

The AP2 mandate names differ between sources.
The AP2 site names Checkout Mandate and Payment Mandate, each open or closed; older sources name Intent, Cart and Payment mandates.
Check the current specification before naming contract fields after AP2, and do not claim AP2 compliance without implementing its schema.

## Agentic commerce protocols

| Name                                | Backer                                                  | Status, November 2026                                                | Covers                                                                                  | B2B fit                                                                      |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| AP2                                 | Google; working groups moved to FIDO Alliance           | v0.2                                                                 | Mandates, authorization, audit chain, verifiable credentials                            | Consumer-oriented; no policy schema for the seller to enforce                |
| UCP                                 | Google and Shopify, with Walmart, Target, Etsy, Wayfair | Dated spec versions from 2026-01-11 to 2026-08-25                    | Discovery, catalog, checkout, signed checkout, AP2 mandates, REST, MCP and A2A bindings | Weak; B2B quotes, contract prices and approvals are proposals (_unverified_) |
| ACP and Instant Checkout            | OpenAI and Stripe                                       | Spec 2026-04-17, beta; Instant Checkout scaled back (_unverified_)   | Product feed, checkout sessions, delegated payment token                                | Weak; card-style, published prices                                           |
| Visa Intelligent Commerce, TAP      | Visa with Cloudflare                                    | TAP launched October 2025                                            | Agent identity through RFC 9421 signatures, payment signals                             | Consumer card payments                                                       |
| Mastercard Agent Pay                | Mastercard                                              | Announced 2025; rollout _unverified_                                 | Agent registration, agentic tokens with transaction controls                            | Consumer card payments                                                       |
| x402                                | Coinbase, Cloudflare, Stripe; Linux Foundation          | V2                                                                   | HTTP 402 pay-per-request settlement                                                     | Micropayments, not ordering                                                  |
| Nevermined                          | Vendor                                                  | Commercial                                                           | Metering and credits for agent-to-agent use                                             | No overlap with ordering                                                     |
| Skyfire KYAPay                      | Skyfire                                                 | Open spec, June 2025                                                 | Signed JWTs with agent owner, scope and spend thresholds                                | Close to the mandate shape, but issued by Skyfire, not signed by the buyer   |
| Shopify Storefront and Checkout MCP | Shopify                                                 | Storefront MCP on by default; Checkout MCP in preview (_unverified_) | MCP catalog search, carts, UCP checkout                                                 | B2C first                                                                    |

Payments (Visa, Mastercard, x402, Nevermined) are out of scope for this project; the PRD simulates pay-on-order.

## B2B procurement agents and ordering standards

| Name                                          | Side                    | Guardrail and approval model                                                                                                                 | Supplier-hosted agent interface                             | Source                                                                                                                                                       |
| --------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SAP Ariba with Joule agents                   | Buyer suite             | Three autonomy levels: flag and wait, resolve with an explanation, self-correct                                                              | No; Ariba Network is a portal                               | [SAP Insider](https://sapinsider.org/blogs/sap-delivers-joule-agents-across-ariba-and-fieldglass-in-june-2026/)                                              |
| Coupa Navi                                    | Buyer suite             | Agents inherit the user's permissions; write-backs carry revision IDs for audit; MCP for the buyer's own agents                              | No                                                          | [Coupa](https://www.coupa.com/newsroom/coupas-september-release-accelerates-agentic-spend-capabilities/)                                                     |
| Zip                                           | Buyer intake-to-pay     | Policy-driven intake routing                                                                                                                 | No                                                          | [BusinessWire](https://www.businesswire.com/news/home/20260602279324/en/)                                                                                    |
| Amazon Business                               | Marketplace             | Typed policies: order value limit, category limit, restricted category; each with its own approval route and a reason message the buyer sees | Not open or standard                                        | [Amazon Business](https://business.amazon.com/en/find-solutions/buying-policies)                                                                             |
| Pactum                                        | Buyer negotiation agent | Preset price ranges and terms; escalates to a human; every action logged                                                                     | Inverse: buyer bot negotiates with supplier humans          | [Pactum](https://pactum.com/blog/agentic-negotiations-procurement)                                                                                           |
| Didero, Microsoft Dynamics 365 supplier agent | Buyer post-order agents | Read supplier email, extract changes and partial fulfilment; a human applies them                                                            | No; suppliers are reached by email                          | [Microsoft Learn](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/supplier-com-agent-apply-email-changes)                             |
| Salesforce B2B Commerce Buyer Agent           | Seller-hosted           | Spend limits and approval routing _unverified_                                                                                               | Yes, but proprietary and aimed at humans on WhatsApp or SMS | [Demand Gen Report](https://www.demandgenreport.com/industry-news/news-brief/salesforce-unveils-new-b2b-commerce-suite-with-agentic-buying-ai-search/53807/) |
| Peppol BIS Ordering, UBL                      | Open EU standard        | Order response codes; Advanced Ordering adds change and cancel                                                                               | Messaging network, not an agent API                         | [Peppol](https://docs.peppol.eu/poacc/upgrade-3/)                                                                                                            |
| Peppol Pre-Award Catalogue                    | Open standard           | Versioned catalogue with a validity period                                                                                                   | Messaging network                                           | [Peppol catalogue](https://docs.peppol.eu/pracc/catalogue/1.0/bis)                                                                                           |
| cXML and PunchOut                             | Legacy B2B              | Lines accepted or backordered with split quantities and dates; a success response is receipt, not a promise to ship                          | Supplier-hosted, but for human punchout sessions            | [punchoutcommerce.com](https://punchoutcommerce.com/guides/transactions/cxml-confirmation-request)                                                           |
| EDIFACT and EANCOM ORDRSP                     | Legacy EDI              | Line actions: accepted, accepted with amendment, not accepted                                                                                | Value-added network                                         | [GS1 EANCOM](https://www.gs1.org/standards/edi-xml-gs1-eancom/eancom-ordrsp-s3/syntax-3)                                                                     |

## Food service and grocery

| Name                                                                                                                                                              | Region     | Side                          | Agentic                                                       | Substitution and approval                                                     | Openness                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------- |
| [Choco](https://choco.com/us/press/choco-and-openai-join-forces-to-launch-the-first-ai-voice-agent-for-the-food-service-industry)                                 | EU, UK, US | Supplier                      | Captures human orders from email, WhatsApp, voice, PDF        | Voice agent checks stock, suggests alternatives and near-expiry promotions    | Closed                       |
| [Pepper](https://help.usepepper.com/en/articles/10280119-order-agent-overview)                                                                                    | US         | Supplier                      | Drafts orders for staff review                                | Suggests similar items on low stock, or notifies after the order              | Closed                       |
| [REKKI](https://rekki.com/article/rekki-connect-order-processing)                                                                                                 | UK         | Supplier and buyer app        | Processes orders from every channel                           | _unverified_                                                                  | Closed                       |
| [Ordermentum](https://help.ordermentum.com/supplier/en/articles/9186996-supplier-how-to-manage-a-standing-order)                                                  | Australia  | Marketplace                   | Drafts orders for human approval                              | Standing orders become real orders at cut-off; cut-offs per route or customer | Closed                       |
| [Cut+Dry](https://cutanddry.com/ai)                                                                                                                               | US         | Supplier                      | Turns text, email and calls into orders                       | _unverified_                                                                  | MCP serves site content only |
| [Sysco](https://distributionstrategy.com/2026/04/sysco-expands-use-of-ai-tools-to-boost-sales-and-customer-growth/)                                               | US         | Supplier                      | Internal agent platform for discovery                         | No agent ordering API found                                                   | Closed                       |
| [US Foods MOXe](https://www.usfoods.com/moxe)                                                                                                                     | US         | Supplier                      | Photo or note to cart, matched to purchase history            | A human confirms                                                              | Closed                       |
| [METRO DISH](https://cloud.google.com/customers/dishdigitalsolutions)                                                                                             | EU         | Supplier and restaurant tools | Shortage prediction, one-click restock                        | A human clicks                                                                | No API found                 |
| Kespro, Heinon Tukku and the challenge sponsor                                                                                                                    | Finland    | Supplier                      | Web shops                                                     | _unverified_                                                                  | No public API found          |
| [Instacart Developer Platform](https://docs.instacart.com/developer_platform_api)                                                                                 | US, Canada | Consumer                      | Recipe and shopping-list link APIs; no checkout API           | Buyer picks best match, a specific replacement, or no replacement             | Partly open                  |
| MarketMan, Apicbase, Galley, Nory                                                                                                                                 | Global     | Buyer (restaurant)            | Par-level and recipe-based reorder; Galley agents are roadmap | Auto-approve below a spend threshold comes from integrators                   | Partly open APIs             |
| [Peppol ordering guide for Finnish retail](https://www.valtiokonttori.fi/en/maaraykset-ja-ohjeet/peppol-ordering-implementation-guide-for-finnish-retail-sector/) | Finland    | Standard                      | Not agentic                                                   | Ordering expects an order response from the supplier                          | Open                         |

An analyst view (Distribution Strategy, February 2026) holds that routine replenishment suits agents while menu variability limits autonomy, which supports escalation to a human.

## Ideas not yet in the PRD

Each idea needs a team decision under R-12 before it changes the PRD or the contract.

1. **Typed policies with stable reason codes**, after Amazon Business: order value, category limit, restricted category, each with a message the buyer sees.
2. **Autonomy level per exception class**, after SAP: flag and wait, resolve and explain, or resolve automatically, set in the mandate.
3. **Substitution preference in the mandate**, after Instacart: best match, a specific replacement or no replacement, per line or per order. Ranked alternatives never relax a hard constraint such as lactose-free or an allergen.
4. **Tolerance rule**, after the 3-way match practice: accept a short delivery or a substitute price within ±X% automatically; above it, go to approval. No 2026 agent product was found that does this.
5. **Cut-off visibility and standing-order drift**, after Ordermentum: show the latest order time for a deliver-by date and flag a standing order that drifts from usual quantities.
6. **Standard vocabulary**: map order and line statuses one to one onto the UBL order response, and pitch the contract as a candidate B2B extension of UCP.

## Unverified or conflicting

- Who signs which AP2 mandate, and its current mandate names.
- UCP B2B extensions: payment terms reportedly added in August 2026; quotes, contract prices and approvals are proposals.
- How Salesforce B2B Buyer Agent enforces limits.
- Whether Amazon Business offers an API for buyer-side agents.
- A substitution code in cXML or EDIFACT; only UBL defines one.
- Substitution handling at REKKI, Ordermentum, BlueCart, Cut+Dry, Amazon and Walmart.
- Whether Kesko sends Peppol orders, and whether the challenge sponsor has a private EDI or API.
