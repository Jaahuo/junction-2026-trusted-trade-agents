# Trusted Trade Agents: implementation specs

Status: living. This file holds implementation detail that [the PRD](prd.md) cannot express clearly (see [document boundaries and change rules](prd.md#document-boundaries-and-change-rules)). Each section links to its PRD heading and defines the contract, the failure paths and the verification. The PRD owns what and why; this file owns the exact shapes. Implementation is pending: these sections state the intended contract, and the code does not implement them yet. Change a section only as [team rules](team-rules.md) R-08 says.

Conventions for all sections: dates are `YYYY-MM-DD`, times are ISO 8601 with offset, money is EUR with 2 decimals, ids are opaque strings. "Std units" are `LTR` or `KGM`. Every object schema is strict: an unknown key fails validation with `400 BAD_REQUEST`. Types used here and not defined here: `Result` from `@app/kernel`; `z` from `zod`; `Headers`, `Request`, `URL`, `Date`, `CryptoKey` and `JsonWebKey` are platform globals.

Host rule: every section uses only standard MCP, the MCP Apps extension and the MCP Skills extension. A host-specific field is an addition behind the standard one, never a replacement.

## SPEC-001 Packages and layering

PRD: [Open contract and adapters](prd.md#open-contract-and-adapters).

- `@app/contract` (root entry `packages/contract/src/index.ts`, browser-safe): types, zod schemas (`<Type>Schema`, the type is `z.infer` of it), constants, `ROUTES`, `VIEWS`, `TOOL_INPUT`, `TOOL_OUTPUT`, `REASON_TEXT`, `DEMO_ACCOUNT`, `fixtures`. It imports only `zod` and `@app/kernel`. Domain, application, infra, api and ui code may import it.
- `@app/contract/server` (entry `packages/contract/src/server/index.ts`): helpers that need `jose` or the environment: `principalOf`, offer and mandate tokens, offer keys, `callRoute`. Server layers only (infra, api).
- Foundation: every context exists with its full route table of SPEC-003 as typed stubs. A stub validates its input with the route's schema, declares the 2xx response schema and the error envelope, and answers `501 NOT_IMPLEMENTED`. A context issue replaces its own stubs. So every peer call typechecks from the start.
- Cross-context calls: an application port, implemented in infra with Eden ``treaty<Api>(`${selfBaseUrl()}/api`, { parseDate: false })`` from `import type { Api } from "@ctx/<peer>/api"`. `parseDate: false` is required on every Eden client: without it Eden turns ISO dates and `YYYY-MM-DD` strings into `Date` objects and the JSON contract breaks. Where the import would create a workspace cycle (orders calling offers), the infra adapter uses `callRoute(routeKey, input)`, which validates the request and the response with the route's schemas.
- Base URLs (`@app/server-kit`): `selfBaseUrl()` = `INTERNAL_BASE_URL` or `http://127.0.0.1:$PORT`; `publicBaseUrl()` = `PUBLIC_BASE_URL` or `selfBaseUrl()`. A context may serve root routes through `ContextModule.root`, mounted after `/api` and before the web fallback.
- Only adapter files in a context's `src/infra/` name the wholesaler.

```ts
export type RouteKey = (typeof ROUTES)[number]["key"];              // the keys of the SPEC-003 table
export type RouteInput<K extends RouteKey> = z.infer<RouteOf<K>["input"]>;    // path parameters and body
export type RouteOutput<K extends RouteKey> = z.infer<RouteOf<K>["output"]>;  // the 2xx body
type RouteOf<K extends RouteKey> = Extract<(typeof ROUTES)[number], { key: K }>;
// @app/contract/server
export const callRoute: <K extends RouteKey>(key: K, input: RouteInput<K>) =>
  Promise<Result<RouteOutput<K>, "UPSTREAM_FAILED" | ErrorCode>>;
```

Failure paths: a browser bundle that imports `@app/contract/server` fails the build. `callRoute` returns `Result<T, "UPSTREAM_FAILED" | ErrorCode>`; it never throws for a non-2xx response.

Verification: `bun build packages/contract/src/index.ts --target=browser` succeeds and its output contains no `jose`, `drizzle` or `from "bun"`. An adapter test sends a fixture with `deliverBy`, `deliveryDate` and `createdAt` through an Eden client and gets the same strings back. A test calls one stub route through a typed Eden client and gets the typed 501 envelope.

## SPEC-002 Demo account and access

PRD: [Roles and access](prd.md#roles-and-access).

The first build has one demo account and no authentication on REST or MCP. Every request acts as the demo account.

```ts
export const PAYMENT_TERMS = ["invoice", "pay_on_order"] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];
export interface Account { accountId: string; label: string; customer: string; agentId: string;
  paymentTerms: PaymentTerms; creditLimit: number | null /* EUR gross; null = no credit check */ }
export type Principal = Account;
export const DEMO_ACCOUNT: Account;                          // values in SPEC-015
// @app/contract/server
export const principalOf: (headers: Headers) => Promise<Result<Principal, "NOT_AUTHENTICATED">>;  // first build: always ok(DEMO_ACCOUNT)
```

- Every route gets its principal from `principalOf`. No route reads a customer, account or agent from the body; a body field `customer` → 400.
- `creditLimit` and `paymentTerms` of the principal come from `DEMO_ACCOUNT`. An offers request whose `paymentTerms` differ from the principal's → 400 `BAD_REQUEST`.
- Audit actor follows the route, not the caller: model tool routes write `agent`; the decision route and the mandate write routes write `approver`; jobs write `server`.
- Human approval: the model sees no decision tool (SPEC-012). The human decides on the approval card or on the approval page `/approvals/<orderId>`. Known limit of the first build: anyone who reaches the public URL can call every route, including decisions. The README says so. In the first build the REST routes are unauthenticated, so the human-only approval guarantee holds for the MCP tools (the model gets no decision tool); the REST decision route is open until accounts arrive.

Failure paths: none in the first build (`principalOf` always succeeds).

Verification: a test that `principalOf(new Headers())` returns `DEMO_ACCOUNT`; a test that a body field `customer` gives 400 on each POST route.

### Later: accounts and authorization

This is the intended product behaviour. It is not built in the first build.

- A second account `acct_pay` (SPEC-015), on pay-on-order. The placement operation then runs the pay-on-order step (SPEC-010).
- `principalOf` reads `Authorization: Bearer <token>`: a compact JWT, HS256, key `SESSION_SIGNING_KEY` (32 bytes or more, base64url), claims `sub` (accountId), `customer`, `agentId`, `paymentTerms`, `creditLimit`, `capabilities`, `iat`, `exp`; lifetime 7 days, no refresh token. Missing, malformed or expired → `401 NOT_AUTHENTICATED`; on `/mcp` also `WWW-Authenticate: Bearer resource_metadata="<public>/.well-known/oauth-protected-resource"`.
- Each account has a capability set (`Capability` = a tool name). The default is every tool; a missing capability → `403 FORBIDDEN`.
- Web pages: the screen `/account` lists `GET /api/accounts` and calls `POST /api/accounts/session {accountId}` → `{ token, account }`.
- MCP authorization (OAuth 2.1 shape, mocked, no login): `GET /.well-known/oauth-protected-resource` → `{ resource: "<public>/mcp", authorization_servers: ["<public>"] }`; `GET /.well-known/oauth-authorization-server` → `issuer`, `authorization_endpoint` `/oauth/authorize`, `token_endpoint` `/oauth/token`, `registration_endpoint` `/oauth/register`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`; `POST /oauth/register` → `{ client_id }` for any client; `GET /oauth/authorize` renders an account picker; `POST /oauth/authorize` redirects to `redirect_uri?code&state`; `POST /oauth/token` (authorization_code + PKCE `code_verifier`) → `{ access_token, token_type: "Bearer", expires_in: 604800 }`. Codes are single use, live 5 minutes, and live in memory. Wrong verifier or reused code → `400 {"error":"invalid_grant"}`.

## SPEC-003 Tools, routes and errors

PRD: [Tools](prd.md#tools).

```ts
export const MODEL_TOOLS = [
  "search_products",
  "get_offers",
  "place_order",
  "get_order_status",
  "get_mandate",
  "list_pending_approvals",
] as const; // the model sees these
export const VIEW_TOOLS = ["decide_approval", "register_mandate", "revoke_mandate"] as const; // only a view calls these
export type ToolName = (typeof MODEL_TOOLS)[number] | (typeof VIEW_TOOLS)[number];
export const ERROR_CODES = [
  "BAD_REQUEST",
  "OFFER_INVALID",
  "NOT_AUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "STALE_OFFER",
  "OFFER_EXPIRED",
  "NOT_IMPLEMENTED",
  "UPSTREAM_FAILED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; nextDeliveryDate?: string };
}
export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  OFFER_INVALID: 400,
  NOT_AUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_OFFER: 409,
  OFFER_EXPIRED: 409,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_FAILED: 502,
};
export interface OrderRef {
  orderId: string;
}
export interface MandateRef {
  mandateId: string;
}
export interface DecideApprovalInput {
  orderId: string;
  proposalVersion: number;
  decision: "approve" | "reject" | "edit" | "pick_alternative" | "approve_and_remember";
  next?: "stop" | "alternatives";
  note?: string;
  changes?: { productId: string; quantity?: Quantity; deliverBy?: string }[];
  offerId?: string;
  maxOrderTotal?: number;
}
export const TOOL_INPUT = {
  search_products: SearchRequestSchema,
  get_offers: OffersRequestSchema,
  place_order: PlaceOrderRequestSchema,
  get_order_status: OrderRefSchema,
  get_mandate: EmptySchema,
  list_pending_approvals: EmptySchema,
  decide_approval: DecideApprovalInputSchema,
  register_mandate: RegisterMandateRequestSchema,
  revoke_mandate: MandateRefSchema,
} as const; // EmptySchema = strict {}
```

| Key      | Tool                   | Method and path                      | Context   | Tool input → REST                                                     | Body → 2xx response                                        |
| -------- | ---------------------- | ------------------------------------ | --------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| search   | search_products        | POST /api/catalog/search             | catalog   | input = body                                                          | SearchRequest → SearchResult                               |
| offers   | get_offers             | POST /api/offers                     | offers    | input = body                                                          | OffersRequest → OffersResult                               |
| place    | place_order            | POST /api/orders                     | orders    | input = body                                                          | PlaceOrderRequest → 201 Order (200 on replay)              |
| status   | get_order_status       | GET /api/orders/:orderId             | orders    | `orderId` → path                                                      | → Order                                                    |
| mandate  | get_mandate            | GET /api/mandates/current            | mandates  | none                                                                  | → StoredMandate                                            |
| pending  | list_pending_approvals | GET /api/orders/pending              | orders    | none                                                                  | → PendingList                                              |
| decide   | decide_approval        | POST /api/orders/:orderId/decision   | orders    | `orderId` → path; the rest → body as DecideApprovalRequest (SPEC-011) | DecideApprovalRequest → Order                              |
| register | register_mandate       | POST /api/mandates                   | mandates  | input = body                                                          | RegisterMandateRequest → 201 StoredMandate (200 on replay) |
| revoke   | revoke_mandate         | POST /api/mandates/:mandateId/revoke | mandates  | `mandateId` → path                                                    | → StoredMandate                                            |
| facts    | —                      | POST /api/catalog/facts              | catalog   | —                                                                     | FactsRequest → FactsResult                                 |
| precheck | —                      | POST /api/orders/precheck            | orders    | —                                                                     | PrecheckRequest → Precheck                                 |
| requote  | —                      | POST /api/offers/requote             | offers    | —                                                                     | RequoteRequest → OffersResult                              |
| validate | —                      | POST /api/offers/validate            | offers    | —                                                                     | ValidateRequest → ValidateResult                           |
| account  | —                      | GET /api/accounts/current            | accounts  | —                                                                     | → Account                                                  |
| openapi  | —                      | GET /api/discovery/openapi.json      | discovery | —                                                                     | → OpenAPI 3.1                                              |

- `DecideApprovalInput` is flat because a tool input schema is one object. The MCP binding drops `orderId`, keeps the fields that belong to `decision`, and the REST route validates the result as `DecideApprovalRequest`; a field that does not belong to the decision → 400.
- No tool input has a customer, account, agent, password or passcode field.
- Hard constraints: a `hard` entry whose `attribute` is not in `HARD_CONSTRAINT_ATTRIBUTES`, or whose `is` value is not in `HARD_CONSTRAINT_VALUES` for that attribute, → `400 BAD_REQUEST` with a message that names the attribute. This applies to `search_products`, `get_offers`, `register_mandate` (`standingConstraints.hard`) and the `facts` route.
- Root routes: `GET /.well-known/jwks.json` (offers), `ALL /mcp` (mcp), `GET /views/:view` and `GET /views/harness` (views), `GET /.well-known/trusted-trade.json` and `GET /skills/trusted-trade-ordering/:file` (discovery). An unknown order or mandate id → `404`. All of `ROUTES` is exported as data: `{ key, tool, method, path, context, input, output }`.

Verification: a contract test that `ROUTES` keys, tools, `TOOL_INPUT` and `TOOL_OUTPUT` match this table and that every `TOOL_INPUT` schema is a JSON object schema.

## SPEC-004 Search and product facts

PRD: [Search request](prd.md#search-request).

```ts
export interface Quantity {
  value: number;
  unit: string;
}
export type MatchState = "confirmed" | "contradicted" | "unknown";
export const HARD_CONSTRAINT_ATTRIBUTES = ["lactose"] as const; // attributes with a data mapping below
export type HardConstraintAttribute = (typeof HARD_CONSTRAINT_ATTRIBUTES)[number];
export const HARD_CONSTRAINT_VALUES = { lactose: ["free_from"] } as const satisfies Record<
  HardConstraintAttribute,
  readonly string[]
>;
export interface HardConstraint {
  attribute: HardConstraintAttribute;
  is: (typeof HARD_CONSTRAINT_VALUES)[HardConstraintAttribute][number];
} // { attribute: "lactose", is: "free_from" }
export interface SoftConstraint {
  attribute: string;
  prefer: string;
} // { attribute: "countryOfOrigin", prefer: "fi" }
export interface SearchRequest {
  terms: string[];
  hard: HardConstraint[];
  soft: SoftConstraint[];
  quantity: Quantity;
  deliverBy: string;
  paymentTerms: PaymentTerms;
  originalRequest?: string;
}
export interface SearchCandidate {
  productId: string;
  gtin: string | null;
  name: string;
  category: string;
  match: Record<string, MatchState>;
  orderQuantity: Quantity | null;
  equals: Quantity | null;
  quantityReason?: string;
  deliveryReliability: number | null;
  co2PerKg: number | null;
  substitutes: string[];
}
export interface SearchResult {
  candidates: SearchCandidate[];
  constraints: { hard: HardConstraint[]; soft: SoftConstraint[] };
  mandate: { id: string; version: number } | null;
}
export interface FactsRequest {
  productIds: string[];
  hard: HardConstraint[];
}
export interface ProductFacts {
  productId: string;
  gtin: string | null;
  name: string;
  category: string;
  salesUnit: string;
  allowedLotSize: number;
  perSalesUnit: Quantity | null;
  countryOfOrigin: string | null;
  deliveryReliability: number | null;
  co2PerKg: number | null;
  match: Record<string, MatchState>;
  substitutes: string[];
}
export interface FactsResult {
  products: ProductFacts[];
  unknown: string[];
}
export const ALLERGEN_ATTRIBUTES = ["lactose"] as const; // hard constraint attributes gated by allergenData
```

- The server merges the mandate's standing constraints into the request: hard = request ∪ mandate, soft = request ∪ mandate. `SearchResult.constraints` returns the merged set.
- Supported hard constraints: only the attributes in `HARD_CONSTRAINT_ATTRIBUTES` with the values in `HARD_CONSTRAINT_VALUES`. Another attribute or value is refused with 400 (SPEC-003). A further attribute is added only through a change of this section (team rules R-08), together with its data mapping and its approval rule in SPEC-009.
- Lactose: classification `nutritionalClaim` value `FREE_FROM_LACTOSE` → `confirmed` for `free_from`; `LOW_LACTOSE` → `contradicted` for `free_from`; neither → `unknown`. Missing data is never `confirmed`.
- A supported hard constraint with missing data has the match `unknown`. The product stays a candidate, and its offer carries the `unknown` match in `product.match` (SPEC-006); SPEC-009 sends the order to approval.
- Search matches Unicode words after case and hyphen normalization. The whole words `maito` and `milk` are equivalent; no other translation aliases apply. Every word of a term must match one name in one language. Terms are alternatives. Compound words do not match their substrings. A negated occurrence, such as `milk-free` or `free from milk`, does not match `milk`; `lactose-free milk` does.
- A candidate with any `contradicted` hard constraint is excluded. At most 20 candidates, ranked by confirmed hard constraints, soft matches, name relevance, successful quantity conversion, matched terms, reliability, then product id. A head noun ranks above a modifier; milk chocolate and milk powder rank below milk.
- Supported search soft attributes are `countryOfOrigin` and `category`, compared case-insensitively. An unsupported request or merged standing soft attribute gives 400. Each matched preference adds a `confirmed` entry to candidate `match`, with key `soft:<attribute>:<encoded-preference>`; the preference is lowercase and URI-component encoded. These entries do not affect hard filtering or hard-confirmation counts. Facts and offer product matches remain hard-only.
- Quantity uses structured sales-unit volume or consumer-unit volume times consumer units per sales unit. `GRM` converts to `KGM`. Count sales units round up to a whole number compatible with `allowedLotSize`; weight sales units retain fractional lots. No supported conversion gives null `orderQuantity` and `equals`, with a `quantityReason` explanation. Successful conversions omit `quantityReason`.
- The index loads once per process; parallel first requests share one load.

Data meaning:

- `deliveryReliability`: the historical ratio of delivered to ordered quantity, 0 to 1; `null` when the product has no value.
- `co2PerKg`: the estimated average kg CO2-eq per kg for the product's group, not a measurement of the product; `null` when absent.
- Nutrition and allergen data are often missing for fresh produce. A missing value is `unknown`, never "free from".

Failure paths: empty `terms` → 400. An unsupported hard constraint attribute or value → 400 (SPEC-003). An unsupported search soft attribute, including a standing preference, → 400.

Verification: a request with an unsupported hard constraint attribute gets 400 on search, offers and mandate registration.

## SPEC-005 Wholesaler adapter

PRD: [Open contract and adapters](prd.md#open-contract-and-adapters).

```ts
export interface PriceQuote {
  productId: string;
  unitPrice: { net: number; vatRate: number; currency: "EUR" };
  deposit: number /* per sales unit */;
  comparisonPrice: { value: number; unit: "LTR" | "KGM" } | null;
  validTo: string;
}
export interface AvailabilityQuote {
  productId: string;
  amount: number /* sales units */;
  availableDate: string | null;
  nextDeliveryDate: string | null;
  cutoffAt: string | null;
  salesBlocked: boolean;
  stock: "confirmed" | "unconfirmed";
}
export interface LiveQuery {
  customer: string;
  requestedDate: string;
  productIds: readonly string[] /* 1..1000 */;
}
export interface WholesalerLive {
  getAvailability(
    q: LiveQuery,
  ): Promise<Result<{ quotes: AvailabilityQuote[]; missing: string[] }, "UPSTREAM_FAILED">>;
  getPrices(
    q: LiveQuery,
  ): Promise<Result<{ quotes: PriceQuote[]; missing: string[] }, "UPSTREAM_FAILED">>;
}
export interface WholesalerCatalog {
  searchCatalog(req: SearchRequest): readonly SearchCandidate[];
  facts(req: FactsRequest): FactsResult;
  getSubstitutes(productId: string): readonly string[];
}
```

- Mapping from the mock's availability response (`ProductAvailability` with `closingTime`, `salesBlock` and `scheduleLines[]` of `availableAmount`, `availableDate`, `salesBlock`): `availableDate` = the first schedule line with an amount above 0 and no sales block; `amount` = that line's amount; `cutoffAt` = `closingTime`; `salesBlocked` = the product's or that line's block.
- `nextDeliveryDate` = the first schedule line date later than `availableDate`. When the response has none, the adapter makes one further availability query with the requested date set to `availableDate` + 1 day, at most one per product per call, and takes its `availableDate`. A failed or empty further query gives `null`.
- An amount of `999999` means `stock: "unconfirmed"`. Order submission is the order store itself (SPEC-010).
- Live adapter choice for offers: `WHOLESALER_LIVE=mock`, with the wholesaler API key set. With any other value or no API key, `get_offers` returns HTTP 200 and omits every line with reason `NO_PRICE`. The omission detail states that no live price source is configured. No offer is signed, and offers never invent a price. Catalog choice: `WHOLESALER_CATALOG=file|json`; `json` is the second, portable catalog adapter. Each context selects its adapters in one file, `src/api/adapters.ts`.
- Quotes are cached per customer, date and product until `validTo`. The cache serves offer issuance only: `validate` (at placement and at approval) always sends a fresh availability request and never reads availability from the cache.

Failure paths: transport error or non-2xx upstream → `UPSTREAM_FAILED` (route answers 502).

Verification: a mapping test with a recorded response in the documented shape, including a response with no later schedule line.

## SPEC-006 Signed offers

PRD: [Signed offer](prd.md#signed-offer), [Delivery later than requested](prd.md#delivery-later-than-requested), [Products that cannot be offered](prd.md#products-that-cannot-be-offered).

Later hardening: `requote`, `validate` and the live-amount rule. This part is built in the later hardening issues and is reviewed again before that work starts.

```ts
export interface OffersRequest { lines: { productId: string; quantity: Quantity /* sales unit */ }[]; deliverBy: string;
  paymentTerms: PaymentTerms; hard: HardConstraint[]; soft: SoftConstraint[] }
export interface OfferClaims { iss: string; offerId: string; customer: string; agentId: string; productId: string;
  quantity: Quantity; unitPrice: PriceQuote["unitPrice"]; deposits: number; total: { net: number; gross: number };
  deliveryDate: string; requestedDate: string; nextDeliveryDate: string | null; stock: "confirmed" | "unconfirmed";
  paymentTerms: PaymentTerms; cutoffAt: string | null; replaces: string | null;
  shortfall: Quantity | null /* std units; sales units when perSalesUnit is null */;
  mandateId: string | null; mandateVersion: number | null;
  constraints: { hard: HardConstraint[]; soft: SoftConstraint[] };            // merged set, SPEC-004
  product: { name: string; category: string; perSalesUnit: Quantity | null; countryOfOrigin: string | null;
    deliveryReliability: number | null; co2PerKg: number | null; match: Record<string, MatchState> };
  iat: number; exp: number }
export interface Precheck { decision: "auto" | "needs_approval" | "rejected"; reasons: ReasonCode[] }
export type OmitReason = "NO_PRICE" | "SALES_BLOCKED" | "NO_DELIVERY_DATE" | "UNKNOWN_PRODUCT" | "INVALID_QUANTITY"
  | "INSUFFICIENT_STOCK" | "CONSTRAINT_CONTRADICTED";
export interface OfferLine { offerId: string; token: string; claims: OfferClaims; precheck: Precheck | null;
  rank: "good" | "better" | "best" | null;
  comparison: { replaces: string; pricePerStdUnitDelta: number | null; reliabilityDelta: number | null; originDiffers: boolean | null } | null }
export interface OffersResult { offers: OfferLine[]; omitted: { productId: string; reason: OmitReason; detail: string }[] }
export interface RequoteRequest { tokens: string[]; changes?: { productId: string; quantity?: Quantity; deliverBy?: string }[] }
export interface ValidateRequest { tokens: string[] }
export interface ValidateResult { results: ({ offerId: string; ok: true } | { offerId: string; ok: false; reason: "SALES_BLOCKED" | "NO_DELIVERY_DATE" | "CUTOFF_PASSED"; nextDeliveryDate: string | null })[];
  products: { productId: string; liveAmount: Quantity | null /* sales units; null = stock unconfirmed */ }[] }
// @app/contract/server
export interface OfferSigningKey { kid: string; privateKey: CryptoKey; publicJwk: JsonWebKey }
export type OfferKeySet = (kid: string) => Promise<CryptoKey | null>;
export const offerSigningKeyFromEnv: () => Promise<OfferSigningKey>;
export const localOfferKeys: (jwks: { keys: JsonWebKey[] }) => OfferKeySet;
export const remoteOfferKeys: (jwksUrl: URL) => OfferKeySet;   // caches; refetches once on an unknown kid
export const signOfferToken: (claims: Omit<OfferClaims, "iat" | "exp">, key: OfferSigningKey, exp: Date) => Promise<string>;
export const verifyOfferToken: (token: string, keys: OfferKeySet, now?: Date) =>
  Promise<Result<OfferClaims, { code: "OFFER_INVALID" } | { code: "OFFER_EXPIRED"; claims: OfferClaims }>>;
```

Steps of `get_offers`:

1. Principal from `principalOf`. The `customer` and `agentId` claims are the principal's. `paymentTerms` other than the principal's → 400.
2. Validate each line: quantity finite and above 0, unit equal to the product's `salesUnit`, value a multiple of `allowedLotSize`. A failing line → omitted `INVALID_QUANTITY`.
3. Load the current mandate; merge standing constraints (SPEC-004). Load facts with the merged hard constraints. A `contradicted` hard constraint → omitted `CONSTRAINT_CONTRADICTED`.
4. Availability first, for `deliverBy`. Then prices for the actual delivery date (`availableDate`), not the requested date.
5. Omit lines with no price, a sales block or no date. Confirmed amount below the request → SPEC-007; a floored amount of 0 → omitted `INSUFFICIENT_STOCK`.
6. Sign with ES256: header `{ alg: "ES256", kid, typ: "offer+jwt" }`; `exp` = earliest of `validTo` and `cutoffAt`; `iss` = `publicBaseUrl()`; `mandateId` and `mandateVersion` of the current mandate, or null.
7. Pre-check each offer through `POST /api/orders/precheck`; on failure `precheck` is null and the offer still returns. `get_offers` writes no order, credit or audit record.

- Verification of a token checks the signature (by `kid`), `alg`, `typ` and `exp`. It does not compare `iss` with the current public URL, so a tunnel restart with a new URL keeps issued offers valid.
- Totals: gross = (net × (1 + vatRate/100) + deposit) × quantity value, rounded to cents.
- Keys: `OFFER_SIGNING_JWK` (private ES256 JWK) and `OFFER_SIGNING_KID`. With both set, a restart keeps every issued offer valid. When they are unset and `NODE_ENV` is not `production`, `offerSigningKeyFromEnv` generates a key for the process and logs one warning; in `production` it throws and the server does not start. `GET /.well-known/jwks.json` publishes the public key only.
- `requote`: re-issues offers for the same product, quantity and date (or the given changes) of the given tokens, under the current mandate of the token's `agentId`.
- `validate`: re-reads live availability of the tokens' products with a fresh availability request (SPEC-005) and reports a sales block, a lost date or a passed cut-off. It also reports the live confirmed amount per product in `products[].liveAmount`, `null` when stock is unconfirmed.
- Live-amount rule: when the live amount of a product is lower than the summed order quantity of that product (SPEC-009), the offers are stale. At `place_order` the request is refused with `409 STALE_OFFER` and the agent requests new offers (SPEC-009 R6). At approval the order goes through the re-quote path (SPEC-011).

Failure paths: upstream down → 502 `UPSTREAM_FAILED`. A body field `customer` → 400. Verification: one test per step and per failure path.

## SPEC-007 Partial stock and substitution

PRD: [Partial stock](prd.md#partial-stock), [Substitution](prd.md#substitution).

- Confirmed amount below the request: floor the available amount to a multiple of `allowedLotSize`. A result of 0 → omitted `INSUFFICIENT_STOCK`. Otherwise one offer for the floored amount, with `shortfall` = request − floored amount, in std units; when `perSalesUnit` is null, in the sales unit.
- For the shortfall, substitute candidates come from the product's substitution pairs. Mandate `substitutions: "never"` → no substitute offers. A substitute with a `contradicted` merged hard constraint is excluded. A substitute quantity rounds up to its own lot size.
- Rank: best first, by soft matches, then price per std unit, then reliability, then CO2. Up to 3 substitute offers, each covering the shortfall, with `replaces`, `rank` and `comparison`.
- Unconfirmed stock: the offer says so and carries the reliability score.

## SPEC-008 Mandate

PRD: [Mandate](prd.md#mandate), [Buyer's limits](prd.md#buyers-limits).

```ts
export type Policy = "auto" | "ask";
export interface MandateLimits { maxOrderTotal: { value: number; currency: "EUR"; basis: "gross" };
  categories: string[] | null /* null = all */; substitutions: "never" | "ask" | "auto"; newProducts: Policy;
  minDeliveryReliability: { value: number; ifNoData: Policy } | null; maxCo2PerKg: { value: number; ifNoData: Policy } | null;
  allergenData: { ifNoData: Policy }; paymentTerms: Record<PaymentTerms, Policy> }
export interface Mandate { iss: string /* customer */; mandateId: string; version: number; agent: string /* agentId */;
  signedBy: string /* accountId */; limits: MandateLimits; standingConstraints: { hard: HardConstraint[]; soft: SoftConstraint[] };
  iat: number; exp: number }
export interface StoredMandate { mandate: Mandate; jws: string | null; status: "active" | "revoked"; registeredAt: string }
export interface RegisterMandateRequest { operationId?: string; limits: MandateLimits;
  standingConstraints: { hard: HardConstraint[]; soft: SoftConstraint[] }; exp?: number }
// @app/contract/server
export const signMandate: (m: Mandate, key: JsonWebKey) => Promise<string>;              // ES256 compact JWS, typ "mandate+jwt"
export const verifyMandate: (jws: string, key: JsonWebKey) => Promise<Result<Mandate, "MANDATE_INVALID">>;
```

- One active mandate per customer and agent. Register revokes the previous one in the same transaction; the server sets `iss`, `agent` and `signedBy` from the principal, `mandateId` (new), `version` (previous + 1) and `iat`; `exp` defaults to `iat` + 365 days.
- `operationId`: a repeated register with the same operationId returns the stored mandate with 200 and changes nothing.
- Signature (simulated custody): the register handler signs the stored payload with `BUYER_SIGNING_JWK` and stores the JWS with it, in the same transaction. The stored JWS decodes to exactly the stored mandate. An externally signed JWS is out of scope.
- The wholesaler uses the stored limits only to enforce them and returns them only to the customer's own principal.

Failure paths: a body with `iss`, `agent`, `signedBy`, `mandateId`, `version` or `iat` → 400. A new registration with `exp` less than or equal to the server time in epoch seconds → 400 `BAD_REQUEST`; the current mandate does not change. The `operationId` replay rule takes precedence, even when the original mandate has expired. No current mandate → 404. An expired mandate is not current.

## SPEC-009 Rule checks and reason codes

PRD: [Rules and decisions](prd.md#rules-and-decisions), [Reason codes](prd.md#reason-codes).

```ts
export const APPROVAL_REASONS = ["SPEND_OVER_LIMIT", "CATEGORY_NOT_ALLOWED", "SUBSTITUTION", "NEW_PRODUCT",
  "RELIABILITY_BELOW_MIN", "CO2_ABOVE_MAX", "UNCONFIRMED_DATA", "UNCONFIRMED_ALLERGEN", "UNCONFIRMED_STOCK",
  "QUANTITY_UNUSUAL", "PAYMENT_TERMS", "PRICE_CHANGED", "AVAILABILITY_DIFFERS"] as const;
export const REJECT_REASONS = ["NOT_AUTHENTICATED", "MANDATE_INVALID", "OFFER_INVALID", "OFFER_EXPIRED",
  "CREDIT_LIMIT", "PAYMENT_FAILED", "CUTOFF_PASSED", "SALES_BLOCKED"] as const;
export type ReasonCode = (typeof APPROVAL_REASONS)[number] | (typeof REJECT_REASONS)[number];
export const REASON_TEXT: Record<ReasonCode, string>;         // one plain sentence each
export const FORCED_APPROVAL = ["QUANTITY_UNUSUAL", "UNCONFIRMED_STOCK"] as const;   // no mandate setting turns these into auto
export const GUARDRAILS = { quantityCapFactor: 10, quantityCapNoHistory: 2000 /* std units */,
  unconfirmedStockMax: 500 /* std units per product */, paymentFailAbove: 5000 /* EUR gross */, maxLinesPerOrder: 20 } as const;
export interface Evaluation { decision: "auto" | "needs_approval" | "rejected"; reasons: ReasonCode[] }
export type Evaluate = (input: { claims: OfferClaims[]; mandate: Mandate | null; history: { productId: string; quantity: Quantity }[];
  live: ValidateResult | null; now: Date }) => Evaluation;    // pure: no I/O, no writes
```

`NOT_AUTHENTICATED` is not produced in the first build. `OFFER_INVALID` is a refusal (400), never a stored reason; it stays in the list because the PRD names it.

Precedence for `place_order` (one list; the first matching step R1-R7 ends the request):

- R1. The body fails its schema, or holds 0 or more than 20 tokens → `400 BAD_REQUEST`. No record.
- R2. The idempotency key is known: same tokens → `200` with the stored order; other tokens → `409 CONFLICT`.
- R3. A token fails verification (malformed, bad signature, wrong `alg`, `typ` or `kid`), or the request repeats a token or verified offer ID → `400 OFFER_INVALID`.
- R4. Tokens differ in `customer` or `paymentTerms`, or the customer is not the principal's → `400 BAD_REQUEST`.
- R5. A current mandate exists and a token's `agentId`, `mandateId` or `mandateVersion` differs from it → `409 STALE_OFFER` ("request new offers").
- R6. `validate` reports a live amount below the summed quantity of a product → `409 STALE_OFFER` (live-amount rule, SPEC-006).
- R7. After validation and the transactional idempotency-key recheck, a selected offer ID already belongs to an order for this customer → `400 OFFER_INVALID`. This check runs under the customer's placement lock, before placement side effects.
- A selected offer ID is permanently consumed by an order in any status, including `rejected` and `declined`. Existing stored orders also consume their selected offer IDs; no backfill is required.
- Alternatives alone do not consume offer IDs. A previously consumed offer ID can appear as an alternative.
- Future edit and requote operations must retain consumed IDs if they change the selected lines.
- R3-R7 store no order and write one audit record `order_refused` with no order id and the code in `detail`.

Quantities: the quantities of lines for the same product are summed. Every quantity rule (`QUANTITY_UNUSUAL`, `UNCONFIRMED_STOCK`) and every limit applies to the sum per product and to the whole order.

Then the order is stored with every reason collected:

1. No current mandate for the principal's agent → `MANDATE_INVALID`.
2. Expiry: `cutoffAt` passed → `CUTOFF_PASSED` with `nextDeliveryDate`; else `exp` passed → `OFFER_EXPIRED`. Cut-off takes precedence.
3. Fixed guardrails: a sales block or lost date from `validate` → `SALES_BLOCKED` or `CUTOFF_PASSED`. The summed quantity of a product over 10 × the median of that product's order history (sales units, SPEC-010) or, with no history, over 2000 std units (no conversion → over) → `QUANTITY_UNUSUAL`. Unconfirmed stock over 500 std units for a product (no conversion → over) → `UNCONFIRMED_STOCK`.
4. Buyer limits: order gross total over `maxOrderTotal` → `SPEND_OVER_LIMIT`; category not listed → `CATEGORY_NOT_ALLOWED`; `replaces` set and policy not `auto` → `SUBSTITUTION`; no order history row for the product (SPEC-010) and `newProducts: ask` → `NEW_PRODUCT`; reliability below minimum → `RELIABILITY_BELOW_MIN`, missing with `ifNoData: ask` → `UNCONFIRMED_DATA`; CO2 above maximum → `CO2_ABOVE_MAX`, missing with ask → `UNCONFIRMED_DATA`; a merged hard constraint on an attribute in `ALLERGEN_ATTRIBUTES` whose match in the offer is `unknown` and `allergenData.ifNoData: ask` → `UNCONFIRMED_ALLERGEN`; a merged hard constraint whose match is `contradicted` or missing → `UNCONFIRMED_ALLERGEN` whatever the setting; terms policy `ask` → `PAYMENT_TERMS`; `deliveryDate` after `requestedDate` or `shortfall` set → `AVAILABILITY_DIFFERS`.
5. Result: any reject reason → `rejected`; else any approval reason → `pending_approval`; else `commitPlacement` (SPEC-010), which checks credit.

- Invariant: an order with any hard-constraint match that is not `confirmed` is never placed automatically, except an `unknown` match under `allergenData.ifNoData: auto`.
- Steps 1-5 are `evaluate`, a pure function. `precheck` runs R1, R3-R5 (same errors, but no `order_refused` record) and `evaluate`, and returns the decision and reasons. It does not check historical offer consumption, so its result is advisory. It never calls `commitPlacement`, writes nothing and does not check credit. Only `place_order` and approval call `commitPlacement`.

Verification: one rule test per reason; a test that all reasons are listed; one test per R step; a test that `precheck` leaves orders, credit and audit unchanged; a test that an offer whose hard-constraint match is `unknown` is never placed automatically unless the mandate allows it (`allergenData.ifNoData: auto`).

## SPEC-010 Orders and placement

PRD: [Order](prd.md#order), [Order states and exceptions](prd.md#order-states-and-exceptions).

Later hardening: validation at placement (`validate` in `commitPlacement` and R6 of SPEC-009). This part is built in the later hardening issues and is reviewed again before that work starts.

```ts
export const ORDER_STATUSES = [
  "pending_approval",
  "awaiting_payment",
  "placed",
  "rejected",
  "declined",
] as const;
export const AUDIT_EVENTS = [
  "order_requested",
  "order_refused",
  "offer_verified",
  "check_passed",
  "check_failed",
  "sent_to_approval",
  "approved",
  "declined",
  "requoted",
  "edited",
  "payment_authorized",
  "payment_failed",
  "placed",
  "rejected",
] as const;
export interface AuditEvent {
  at: string;
  actor: "agent" | "server" | "approver";
  event: (typeof AUDIT_EVENTS)[number];
  rule?: string;
  reason?: ReasonCode;
  detail?: string;
}
export interface OrderLine {
  offerId: string;
  token: string;
  claims: OfferClaims;
}
export interface Requote {
  at: string;
  previous: OfferClaims;
  current: OfferClaims;
  reasons: ReasonCode[];
}
export interface Order {
  orderId: string;
  customer: string;
  agentId: string;
  accountId: string;
  offerIds: string[];
  lines: OrderLine[];
  alternatives: OrderLine[];
  mandateId: string | null;
  mandateVersion: number | null;
  status: (typeof ORDER_STATUSES)[number];
  reasons: ReasonCode[];
  proposalVersion: number;
  approvalUrl: string | null;
  paymentTerms: PaymentTerms;
  total: { net: number; gross: number };
  originalRequest: string | null;
  decision: {
    action: "approve" | "reject" | "edit" | "pick_alternative" | "approve_and_remember";
    next: "stop" | "alternatives" | null;
    note: string | null;
    by: string;
    at: string;
  } | null;
  requotes: Requote[];
  nextDeliveryDate: string | null;
  audit: AuditEvent[];
  createdAt: string;
}
export interface PendingList {
  orders: Order[];
}
export interface PlaceOrderRequest {
  offers: string[];
  alternatives?: string[];
  originalRequest?: string;
  idempotencyKey: string;
}
export interface PrecheckRequest {
  offers: string[];
}
```

- `place_order` takes signed offer tokens only. `alternatives` are verified tokens of offers the agent did not choose; they are shown on the approval card and do not count in the total.
- Idempotency: unique (customer, idempotencyKey). See SPEC-009 R2.
- `approvalUrl` is computed when the order is read: `${publicBaseUrl()}/approvals/<orderId>` while pending, else null. It is not stored. It points to the approval page (SPEC-013), the one plain page with the approval actions.
- Order history: a table owned by the orders context, with rows `{ productId, quantity /* sales units */, placedAt }`. A placed order adds one row per line. The demo seed adds rows directly; they are not orders and use no credit. `QUANTITY_UNUSUAL` compares sales units with the median of that product's rows; `NEW_PRODUCT` means the product has no row.
- Placement operation `commitPlacement(orderId)`: every move to `placed` goes through it, from `place_order` and from approval. In one transaction with a per-customer lock: re-validate the offers (SPEC-006 `validate`, with its live-amount rule; until that route exists, skipped); invoice: remaining credit = principal's `creditLimit` − gross of placed invoice orders, total above it → `rejected CREDIT_LIMIT`; pay-on-order: a `PaymentPort` step, `awaiting_payment`, then simulated authorization that fails above `paymentFailAbove` → `rejected PAYMENT_FAILED`, else `payment_authorized`; then `placed`. Each step writes its audit event in the same transaction.
- First build: only invoice terms reach `commitPlacement` (SPEC-002); the `PaymentPort` adapter for pay-on-order arrives with the second account.
- Order, lines and audit are written in one transaction. `order_refused` records have no order id and appear in no `Order.audit`.

Failure paths: `validate` unreachable → 502 `UPSTREAM_FAILED`; on `place_order` no order is stored, on approval the order stays pending.

Verification: parallel tests: 10 calls with one idempotency key; two orders that together exceed credit, on both entry paths (approve vs approve, approve vs automatic).

### Peppol/UBL status mapping

This table is a conceptual mapping, not an implemented integration. A [Peppol Order Response](https://docs.peppol.eu/poacc/upgrade-3/profiles/28-ordering/) is a seller's response to a buyer's order. The internal status instead records this application's approval and placement process. It does not establish that a seller received or responded to an order.

The codes below are from the [Peppol subset of UN/CEFACT 4343 for UBL Order Response](https://docs.peppol.eu/poacc/upgrade-3/2025-Q4/codelist/UNCL4343-T76/). A code applies only when the corresponding seller response exists; an internal status alone cannot produce one.

| Internal status or decision          | Potential Peppol response                                                       | Boundary                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pending_approval`                   | No response inferred. `AB` means message acknowledgement, not acceptance.       | Internal approval does not prove seller receipt.                                                |
| `awaiting_payment`                   | No response inferred. `AB` is possible only if the seller acknowledged receipt. | Waiting for payment is not seller acceptance.                                                   |
| `placed`                             | `AP` only if the seller accepts the order.                                      | Internal placement does not prove seller acceptance.                                            |
| `rejected`                           | `RE` only if the seller rejects the order.                                      | An internal rule, credit, or payment rejection is not a seller response.                        |
| `declined` with `next: stop`         | No response inferred; `RE` requires seller rejection.                           | The approver rejected the proposal and chose to stop.                                           |
| `declined` with `next: alternatives` | No response inferred; `RE` requires seller rejection.                           | The approver rejected the proposal and allowed alternatives; this is not a seller substitution. |

`CA` means conditional acceptance. Peppol requires order lines for `CA`; see the [response code rules](https://docs.peppol.eu/poacc/upgrade-3/2025-Q4/syntax/OrderResponse/cbc-OrderResponseCode/). A seller substitution can use [`cac:SellerSubstitutedLineItem`](https://docs.peppol.eu/poacc/upgrade-3/2025-Q4/syntax/OrderResponse/cac-OrderLine/cac-SellerSubstitutedLineItem/). This application does not implement conditional seller responses or line response statuses. Its alternative offers do not represent a seller's substituted line.

The [status and line schemas](../packages/contract/src/orders.ts#L6-L11) define the internal states and [order lines](../packages/contract/src/orders.ts#L40-L45). [Order creation](../contexts/orders/src/application/orders.ts#L167-L203) records alternatives and initial status. [Placement](../contexts/orders/src/application/commit-placement.ts#L1-L84) can reject or place an order. [Approval decisions](../contexts/orders/src/application/approvals.ts#L95-L123) record `stop` or `alternatives` on a decline; only approve and reject are implemented.

The application has no UBL XML serializer or Peppol transport, and does not implement participant location numbers or certified Peppol interoperability. This mapping does not claim conformance or network connectivity.

## SPEC-011 Approval decisions and re-quote

PRD: [Approval card](prd.md#approval-card), [Offer expires while the order waits](prd.md#offer-expires-while-the-order-waits).

Later hardening: re-quote at approval, edit and pick_alternative; approve and remember is specified later (see the end of this section). This part is built in the later hardening issues and is reviewed again before that work starts.

```ts
export type DecideApprovalRequest = { proposalVersion: number } & (
  | { decision: "approve" }
  | { decision: "reject"; next: "stop" | "alternatives"; note?: string }
  | { decision: "edit"; changes: { productId: string; quantity?: Quantity; deliverBy?: string }[] }
  | { decision: "pick_alternative"; offerId: string }
  | { decision: "approve_and_remember"; maxOrderTotal: number }
);
```

- Only `pending_approval` orders accept a decision. `proposalVersion` must equal the order's; else 409 `CONFLICT`. Edit and re-quote increase it by 1. The update filters on status and proposalVersion, so one decision wins.
- Approve: load the current mandate of the order's `agentId`; none → `rejected MANDATE_INVALID`. Lines whose `mandateId` or `mandateVersion` differ from it, whose offers expired, or whose product breaks the live-amount rule of SPEC-006, are re-quoted under it through `requote`. Same or lower price, same date and amount, no new reason → replace the lines, write `requoted`, continue. Else add `PRICE_CHANGED` or `AVAILABILITY_DIFFERS` (or the new rule's reason), append a `Requote`, increase `proposalVersion`, keep pending, return 200 with the order. Then `commitPlacement`. Until `requote` exists: a differing mandate → `409 STALE_OFFER`, an expired offer → `409 OFFER_EXPIRED`, and the order stays pending.
- Reject: `declined`, `decision.next` = `stop` (the agent stops and tells the user) or `alternatives` (the agent may look for alternatives).
- Edit and pick_alternative: new offers through `requote` (or the chosen alternative), every check of SPEC-009 again.
- Cut-off job: every 60 seconds, and through `runCutoffJob()` in tests, every pending order whose earliest `cutoffAt` has passed becomes `declined` with `next: "alternatives"`, actor `server`, filtered on status.

Approve and remember: the approver raises the mandate's order limit and approves the order in one action. The first build answers this decision with `501 NOT_IMPLEMENTED`. The sequence of mandate change, re-quote and approval, its behaviour under concurrent decisions and its retry rule are not part of this contract yet. The hardening issue that builds it adds them through a SPEC change, with a review, before the work starts.

## SPEC-012 MCP binding

PRD: [Tools](prd.md#tools), [Views](prd.md#views), [Skill](prd.md#skill).

- `ALL /mcp`: stateless streamable HTTP, a new server and transport per request, JSON responses. No authentication in the first build (SPEC-002).
- Every tool of SPEC-003 is registered with `inputSchema` = `TOOL_INPUT[tool]` and `outputSchema` = `TOOL_OUTPUT[tool]`. The result has `content` (a text summary) and `structuredContent` (the REST 2xx body). Text of a pending order includes its `approvalUrl`. A REST error, or input that `TOOL_INPUT[tool]` refuses (`BAD_REQUEST`), → `isError: true` and no `structuredContent`; the text has the error code, the message and the envelope as JSON. Reason: an MCP SDK client validates any `structuredContent` against `outputSchema`, also when `isError` is set. So every result with `structuredContent` parses with `TOOL_OUTPUT[tool]`. Hosts without Apps complete the flow from text, structured content and the approval page.
- View tools (`VIEW_TOOLS`) carry the MCP Apps visibility for app-only tools, so the model does not see them. `MCP_VIEW_TOOLS=app` (default) registers them that way; `MCP_VIEW_TOOLS=off` does not register them. Use `off` on a host that shows app-only tools to the model; the approval card then links to the approval page.
- Each tool in `VIEWS` declares the MCP Apps resource link (`_meta.ui.resourceUri`). `resources/read` of a `ui://` URI returns the HTML of `GET /views/<view>`.
- Skills: the files of `skills/trusted-trade-ordering/` are served as the MCP Skills extension defines (https://skills.extensions.modelcontextprotocol.io/specification/beta/skills): the server declares `io.modelcontextprotocol/skills` (value `{}`) in `capabilities.extensions` of `server/discover`, together with the `resources` capability; it answers `skills/list` and `skills/get` with one entry (`uri` `skill://trusted-trade-ordering/SKILL.md`, `frontmatter`, and a complete `resources` manifest of `uri`, `digest` `sha256:<hex>`, and `size` that includes SKILL.md); and it serves each file through `resources/read`. Hosts without the extension download the same two files from `GET /skills/trusted-trade-ordering/:file` (`SKILL.md`, `reason-codes.md`). docs/host-support.md has the details.

## SPEC-013 Views

PRD: [Approval and user-facing views](prd.md#approval-and-user-facing-views).

```ts
export const TOOL_OUTPUT = {
  search_products: SearchResultSchema,
  get_offers: OffersResultSchema,
  place_order: OrderSchema,
  get_order_status: OrderSchema,
  get_mandate: StoredMandateSchema,
  list_pending_approvals: PendingListSchema,
  decide_approval: OrderSchema,
  register_mandate: StoredMandateSchema,
  revoke_mandate: StoredMandateSchema,
} as const;
export const VIEWS = [
  {
    view: "approval-card",
    uri: "ui://trusted-trade/approval-card",
    tools: ["place_order", "list_pending_approvals"],
    plainQuery: null,
    plainLoad: null,
    actions: ["decide_approval"],
  },
  {
    view: "offer-comparison",
    uri: "ui://trusted-trade/offer-comparison",
    tools: ["get_offers"],
    plainQuery: null,
    plainLoad: null,
    actions: [],
  },
  {
    view: "order-timeline",
    uri: "ui://trusted-trade/order-timeline",
    tools: ["get_order_status"],
    plainQuery: "order",
    plainLoad: "status",
    actions: [],
  },
  {
    view: "search-results",
    uri: "ui://trusted-trade/search-results",
    tools: ["search_products"],
    plainQuery: null,
    plainLoad: null,
    actions: [],
  },
  {
    view: "mandate-settings",
    uri: "ui://trusted-trade/mandate-settings",
    tools: ["get_mandate"],
    plainQuery: null,
    plainLoad: "mandate",
    actions: ["register_mandate", "revoke_mandate"],
  },
] as const; // priority order
```

- The `structuredContent` of a tool is the only input of its view. A view parses it with `TOOL_OUTPUT`; a failed parse, or a result with `isError: true` and no `structuredContent` (SPEC-012), shows the error state.
- Host mode: the view reads the tool result through the MCP Apps bridge and calls an action with the bridge's server-tool call. A failed action call shows the error state with a link to the plain page.
- Plain mode (`/views/<view>?order=<id>`, for a view with a `plainQuery`): the view loads `plainLoad` over REST and calls the action's REST route. No token is needed in the first build. The approval card has no plain mode; its plain counterpart is the approval page.
- The approval card shows a link to `approvalUrl` in every pending state.
- Each view is one self-contained HTML file with no external asset. States: loading, empty, error, pending, done, where they apply.
- Views are framework-agnostic Lit web components (`<tt-approval-card>` and others), so any host page or framework can render them. They use the view styles and tokens in `contexts/views/src/shared/styles.ts`, named as the Figma variables of the design file; a later restyle changes no data contract.
- The approval page is the screen `/approvals/<orderId>` of the orders context: one plain page with the approval actions, for unattended runs and hosts without Apps. The Apps approval card is the in-chat view; both call the same decision route (SPEC-011).

## SPEC-014 Discovery and OpenAPI

PRD: [Open contract and adapters](prd.md#open-contract-and-adapters).

- `GET /.well-known/trusted-trade.json` → `{ endpoint, mcp, jwksUri, openapi, skill?, authorization: null, guardrails: GUARDRAILS, paymentTerms: PAYMENT_TERMS, reasonCodes, tools: { model, view }, views }`. `skill` is the optional absolute URL of `/skills/trusted-trade-ordering/SKILL.md`. `authorization` is null while the build has no authentication (SPEC-002).
- `GET /api/discovery/openapi.json`: OpenAPI 3.1 with every `/api` route of `ROUTES`, request and response schemas generated from the contract schemas.

## SPEC-015 Demo seed values

PRD: [Demo and build order](prd.md#demo-and-build-order).

```ts
export interface DemoProducts {
  observedAt: string;
  requestedDate: string;
  s1: { productId: string; quantity: Quantity };
  s2: { productId: string; quantity: Quantity };
  s3: { productId: string; quantity: Quantity } | null /* null = no product found */;
  late: { productId: string } | null;
  triedForS3: { productId: string; quantity: Quantity }[];
}
```

- `DEMO_ACCOUNT`: `{ accountId: "acct_demo", label: "Demo kitchen (invoice)", customer: "cust_invoice_01", agentId: "agent_demo", paymentTerms: "invoice", creditLimit: 5000 }`.
- Later (SPEC-002): `acct_pay` (customer `cust_pay_01`, agent `agent_pay`, pay-on-order, creditLimit null).
- Mandate: maxOrderTotal 1000 EUR gross; categories null; substitutions ask; newProducts ask; reliability 0.9 with ifNoData auto; CO2 3.0 with ifNoData auto; allergenData ifNoData ask; payment terms invoice auto, pay_on_order ask; standing soft constraint countryOfOrigin fi. Demo users may change every value.
- Demo products: the tracked file `data/demo-products.json`, parsed with `DemoProductsSchema`. It holds product ids, quantities, observation time and scenario status only, as the one allowed exception to the dataset rule in [team rules](team-rules.md) R-23. Seeds and scripts read it; when it is absent, seeds add no history and log one warning.
- Order history rows (SPEC-010), in sales units derived from the demo file: S1 product, 3 rows of `s1.quantity`; S2 product, 3 rows of `s2.quantity` / 5, rounded up to a whole sales unit; S3 product (when `s3` is set), 3 rows of `s3.quantity` / 5, rounded up. Scenario 1 (`s1.quantity`) gives no reason; scenario 2 (`s2.quantity`, the 1000 LTR request, gross above 1000 EUR) gives exactly `SPEND_OVER_LIMIT`.
- Credit: placed orders use up the 5000 EUR credit. `bun run db:reset` restores it; run it before each rehearsal.
