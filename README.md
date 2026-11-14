# junction-2026-trusted-trade-agents

> **Unprotected main:** GitHub does not enforce pull requests, CI checks, or an up-to-date base; there is no atomic base guarantee. Coordinate merges manually and enable server-side protection when eligible.

Trusted Trade Agents is an open ordering contract between a buyer's AI agent and a wholesaler.
The agent searches the catalogue, receives signed offers and places orders.
The buyer's mandate sets the limits, and the wholesaler's server enforces them on every order.
A human decides every exception.

## Find the contract

Every wholesaler publishes one discovery file on its own domain.
Start there; it links everything else.

The hosted demo base URL is [https://199-247-4-99.sslip.io](https://199-247-4-99.sslip.io).
The discovery document is a project-specific format, not a UCP profile ([implementation](contexts/discovery/src/api/well-known.ts)).

| What                    | URL (relative to the public base URL)     |
| ----------------------- | ----------------------------------------- |
| Discovery document      | `/.well-known/trusted-trade.json`         |
| OpenAPI 3.1 (REST)      | `/api/discovery/openapi.json`             |
| MCP endpoint            | `/mcp` (streamable HTTP)                  |
| Offer signing keys      | `/.well-known/jwks.json`                  |
| Agent skill (plain web) | `/skills/trusted-trade-ordering/SKILL.md` |

```sh
BASE_URL=https://your-demo-host.example
curl -s "$BASE_URL/.well-known/trusted-trade.json" | jq '{endpoint, mcp, jwksUri, openapi, skill, authorization}'
curl -s "$BASE_URL/api/discovery/openapi.json" | jq '.paths | keys'
```

The discovery document lists the endpoint, the MCP URL, the signing key set, the OpenAPI URL, the skill URL, the fixed guardrails, the payment terms, the reason codes, the model tools, the view-only tools and the views.
`authorization` is `null` because the first build has no authentication.
The OpenAPI document covers every `/api` route; its paths are relative to the public base URL, and the schemas are generated from the same contract schemas that the MCP tools use.
[SPEC-014](docs/specs.md#spec-014-discovery-and-openapi) defines both documents.

## Standards

| Implemented                                                                                                                                                                      | Mapped in docs                                                                          | Next step                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offer [ES256 JWS signing and JWKS](contexts/offers/src/infra/offer-signer.ts); [public key endpoint](contexts/offers/src/api/routes.ts)                                          | —                                                                                       | Independent public-URL verification script ([#69](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/69)).                         |
| [OpenAPI 3.1 and JSON Schema](contexts/discovery/src/api/openapi.ts); [MCP tool JSON Schema](contexts/mcp/src/api/mcp-server.ts)                                                 | —                                                                                       | —                                                                                                                                                   |
| [MCP and MCP Apps resources and tools](contexts/mcp/src/api/mcp-server.ts)                                                                                                       | —                                                                                       | Measure the full approval flow in the chosen host ([#19](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/19)).                  |
| [Nullable GTIN on search candidates](contexts/catalog/src/infra/product-file.ts); [unit codes including UN/CEFACT codes where supplied](contexts/catalog/src/domain/quantity.ts) | —                                                                                       | Data does not always provide a GTIN or a usable unit conversion.                                                                                    |
| [AP2-style signed mandate](contexts/mandates/src/infra/buyer-key.ts), with server-simulated buyer custody                                                                        | —                                                                                       | Buyer-side key custody and mandate signature verification on use ([#123](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/123)). |
| [Internal order statuses only](contexts/orders/src/infra/schema.ts)                                                                                                              | [Peppol/UBL status mapping](docs/specs.md#peppolubl-status-mapping), documentation only | Implement an interoperable exchange if needed; no Peppol or UBL exchange is implemented.                                                            |

## Verify an offer

Each offer line from `get_offers` carries `token`, a compact JWS signed with ES256 and the header `typ: offer+jwt`.
Anyone can check it against the wholesaler's public key set:

```sh
curl -s "$BASE_URL/.well-known/jwks.json" | jq '.keys[0] | {kty, crv, alg, kid}'

npm install jose
TOKEN='<token from an offer line>' BASE_URL="$BASE_URL" node --input-type=module -e '
import { createRemoteJWKSet, jwtVerify } from "jose";
const jwks = createRemoteJWKSet(new URL(`${process.env.BASE_URL}/.well-known/jwks.json`));
const { payload, protectedHeader } = await jwtVerify(process.env.TOKEN, jwks, { algorithms: ["ES256"], typ: "offer+jwt" });
console.log(protectedHeader.kid, payload.offerId, payload.total);
'
```

A changed claim, another key or an expired offer fails the check.
The server publishes the offer signing key set at `/.well-known/jwks.json`.

## Known limits of the first build

- **No authentication in the first build.** There is one demo account, the invoice customer with a credit limit and one agent, and every REST and MCP request acts as it. Accounts, a second pay-on-order account and the MCP authorize step (OAuth, as MCP specifies) are planned; see [SPEC-002 "Later"](docs/specs.md#later-accounts-and-authorization).
- **Anyone with the demo URL can open the approval page** (`/approvals/<orderId>`) and call every REST route, including the approval decision.
- **The model sees no decision tool.** The decision, mandate registration and revoke tools are view-only: the MCP server marks them with app-only visibility (`MCP_VIEW_TOOLS=off` removes them), so a host hides them from the model and the agent cannot approve its own order. A human decides on the approval card or the approval page. A direct REST or MCP client can still call the decision until accounts arrive.
- **The wholesaler uses the buyer's limits only to enforce them.** It returns them only to the buyer's own account.
- **Key custody is simulated.** The server signs the AP2-style mandate with a demo buyer key on the buyer's behalf. The order service [reads the mandate without verifying its signature](contexts/orders/src/infra/mandate-client.ts); signature verification on use is open in [#123](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/123).
- **The mock ignores the customer number.** Customer-specific limits, credit and payment terms are simulated in our layer.
- **A sales block after quoting holds until the offer expires.** An offer stays valid until it expires even if the product is blocked after quoting; validation at placement arrives with [#30](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/30).
- **Offer totals leave deposits out.** The wholesaler's price API gives no deposit amount, and the product data names deposit materials without a price, so every offer says `depositsIncluded: false` and the spend limit is checked on a total without deposits; mentor question in [#76](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/76).
- **Count sales units are whole units.** Search rounds cases, pieces and packs up to whole sales units and preserves lot multiples. The dataset's fractional `allowedLotSize` values do not establish that customers may split a case; mentor confirmation is pending ([#76](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/76)).

## Demo host

The owner chose Open WebUI with voice for the demo, with human approval on the in-chat card and the phone approval page as fallback ([#44](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/44)).
In a historical Open WebUI 0.13.3 spike, voice called `search_products` and the search view rendered. The approval link was not tested in that run.
These results do not establish support in other hosts or for the complete current approval flow. See [host support](docs/host-support.md) for measured results and limits.

## Assumptions

- The demo uses one unauthenticated account. It is not a production access boundary.
- The wholesaler enforces the buyer's mandate and can see its limits. Buyer key custody is simulated.
- The challenge dataset is illustrative. Product identifiers and conversions can be missing, and fractional case splitting needs mentor confirmation.
- The reference Notes screen is currently included by the [web shell](apps/web/src/main.tsx). Removing it and its seed from the production build is tracked in [#134](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/134); the reference context remains.

## Next steps

- Authenticate approvers separately, for example with a passkey or OpenID CIBA. Add accounts, pay-on-order and MCP OAuth ([#34](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/34)).
- Verify mandate signatures on use and move buyer key custody to the buyer ([#123](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/123)).
- Add offer validation and re-quote, remaining decisions and placement checks ([#29](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/29), [#30](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/30)).
- Complete the offer comparison and mandate settings views ([#22](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/22), [#31](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/31)), and approval edits and alternatives ([#124](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/124)).
- Prove portability with a second adapter ([#33](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/33)). Add a rolling budget across orders if time remains ([#75](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/75)).
- Add the first Valio Aimo skin as a wholesaler theme when [#73](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/73) is complete.
- Harden offers: add comparison prices and deposits, identify unconfirmed stock, and refresh availability ([#120](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/120)).
- Consider the proposed trust chain: verify signatures in views ([#68](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/68)), and add signed receipts and a hash-chained audit record ([#70](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/70)).
- Consider the proposed support for all GS1 allergens and free-from claims ([#71](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/71)) and agent rationale on order lines ([#72](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/72)).
- Demonstrate only attacks the first build stops; measure the host flow and rogue-agent scenarios ([#19](https://github.com/Jaahuo/junction-2026-trusted-trade-agents/issues/19)).

## Setup

Install mise, Docker with Compose, Git and GitHub CLI. Run `mise install`, then `bun install --frozen-lockfile` and `bun run setup` to initialize this worktree's local PostgreSQL runtime. Keep secrets in ignored `.env`; see `.env.example` and [runtime guidance](docs/runtime.md).

## Product requirements

The [living PRD](docs/prd.md) owns product scope, behavior, acceptance criteria and open questions. Its [change rules](docs/prd.md#document-boundaries-and-change-rules) keep requirements and implementation consistent. Add consolidated specs and ADRs only when needed; do not create a document per change.

## Data

- The challenge dataset is inspired by the real world but is not fully accurate. Do not use it outside the challenge.
- Delivery reliability is the historical ratio of delivered quantity to ordered quantity, from 0 to 1. It is not present for every product.
- The CO2 value is an average per kilogram for the product group. It is not a measurement of the product.

## Challenge data

Read the [challenge brief](docs/challenge.md) for requirements, scope and judging criteria. It replaces the original PDF.

Use the supplied [OpenAPI specification](docs/open_api.json) for mock API endpoints, request/response schemas and `X-API-Key` authentication. Use the [resource portal](https://junction26.valioaimo.fi/) for access instructions and updates. Keep credentials in ignored `.env`, not in documentation.

The API specification is `docs/open_api.json`. The `data/` directory contains four original datasets:

- [Delivery reliability](data/valio_aimo_junction26_delivery_reliability.csv)
- [Carbon footprint](data/valio_aimo_junction26_carbon_footprint.csv)
- [Product data schema](data/valio_aimo_junction26_product_data_schema.json)
- [Product data](data/valio_aimo_junction26_product_data.json)

The four dataset files remain byte-for-byte unchanged. Formatting excludes `data/` and `docs/open_api.json` to preserve the source files. The product dataset contains 17,546 records. Narrow the product selection with static data before querying dynamic prices and availability; do not repeatedly query the full catalog. The template's MIT license and attribution remain unchanged; this project does not assign that license to the supplied challenge resources.

## Commands

- `bun run dev`: start the app.
- `bun run production`: build and serve the production demo.
- `bun run gate`: run integrated checks.
- `bun run task`: manage assigned issues; see [workflow](docs/workflow.md).
- `bun run ship`: open or merge a PR following the workflow.
- `bun run runtime:status`: inspect the worktree runtime.

See [agent rules](AGENTS.md), [writing skills](docs/agent-skills.md), [design](DESIGN.md), [sponsor guidance](docs/sponsors.md) and [license](LICENSE).
