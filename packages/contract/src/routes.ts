import { z } from "zod";
import { AccountSchema } from "./account.ts";
import { EmptySchema } from "./common.ts";
import { DecideApprovalRouteInputSchema } from "./decision.ts";
import {
  DraftMandateRequestSchema,
  MandateDraftSchema,
  MandateRefSchema,
  RegisterMandateRequestSchema,
  StoredMandateSchema,
} from "./mandate.ts";
import {
  OffersRequestSchema,
  OffersResultSchema,
  PrecheckSchema,
  RequoteRequestSchema,
  ValidateRequestSchema,
  ValidateResultSchema,
} from "./offers.ts";
import {
  OrderRefSchema,
  OrderSchema,
  PendingListSchema,
  PlaceOrderRequestSchema,
  PrecheckRequestSchema,
} from "./orders.ts";
import {
  FactsRequestSchema,
  FactsResultSchema,
  SearchRequestSchema,
  SearchResultSchema,
} from "./search.ts";

/** An OpenAPI 3.1 document. */
export const OpenApiDocumentSchema = z.looseObject({ openapi: z.string() });

/** The SPEC-003 route table. `input` holds the path parameters and the body. */
export const ROUTES = [
  {
    key: "search",
    tool: "search_products",
    method: "POST",
    path: "/api/catalog/search",
    context: "catalog",
    input: SearchRequestSchema,
    output: SearchResultSchema,
  },
  {
    key: "offers",
    tool: "get_offers",
    method: "POST",
    path: "/api/offers",
    context: "offers",
    input: OffersRequestSchema,
    output: OffersResultSchema,
  },
  {
    key: "place",
    tool: "place_order",
    method: "POST",
    path: "/api/orders",
    context: "orders",
    input: PlaceOrderRequestSchema,
    output: OrderSchema,
  },
  {
    key: "status",
    tool: "get_order_status",
    method: "GET",
    path: "/api/orders/:orderId",
    context: "orders",
    input: OrderRefSchema,
    output: OrderSchema,
  },
  {
    key: "mandate",
    tool: "get_mandate",
    method: "GET",
    path: "/api/mandates/current",
    context: "mandates",
    input: EmptySchema,
    output: StoredMandateSchema,
  },
  {
    key: "draft",
    tool: "draft_mandate",
    method: "POST",
    path: "/api/mandates/drafts",
    context: "mandates",
    input: DraftMandateRequestSchema,
    output: MandateDraftSchema,
  },
  {
    key: "pending",
    tool: "list_pending_approvals",
    method: "GET",
    path: "/api/orders/pending",
    context: "orders",
    input: EmptySchema,
    output: PendingListSchema,
  },
  {
    key: "decide",
    tool: "decide_approval",
    method: "POST",
    path: "/api/orders/:orderId/decision",
    context: "orders",
    input: DecideApprovalRouteInputSchema,
    output: OrderSchema,
  },
  {
    key: "register",
    tool: "register_mandate",
    method: "POST",
    path: "/api/mandates",
    context: "mandates",
    input: RegisterMandateRequestSchema,
    output: StoredMandateSchema,
  },
  {
    key: "revoke",
    tool: "revoke_mandate",
    method: "POST",
    path: "/api/mandates/:mandateId/revoke",
    context: "mandates",
    input: MandateRefSchema,
    output: StoredMandateSchema,
  },
  {
    key: "facts",
    tool: null,
    method: "POST",
    path: "/api/catalog/facts",
    context: "catalog",
    input: FactsRequestSchema,
    output: FactsResultSchema,
  },
  {
    key: "precheck",
    tool: null,
    method: "POST",
    path: "/api/orders/precheck",
    context: "orders",
    input: PrecheckRequestSchema,
    output: PrecheckSchema,
  },
  {
    key: "requote",
    tool: null,
    /** Typed stub: always answers 501 NOT_IMPLEMENTED until its hardening issue builds it. */
    notImplemented: true,
    method: "POST",
    path: "/api/offers/requote",
    context: "offers",
    input: RequoteRequestSchema,
    output: OffersResultSchema,
  },
  {
    key: "validate",
    tool: null,
    /** Typed stub: always answers 501 NOT_IMPLEMENTED until its hardening issue builds it. */
    notImplemented: true,
    method: "POST",
    path: "/api/offers/validate",
    context: "offers",
    input: ValidateRequestSchema,
    output: ValidateResultSchema,
  },
  {
    key: "account",
    tool: null,
    method: "GET",
    path: "/api/accounts/current",
    context: "accounts",
    input: EmptySchema,
    output: AccountSchema,
  },
  {
    key: "openapi",
    tool: null,
    method: "GET",
    path: "/api/discovery/openapi.json",
    context: "discovery",
    input: EmptySchema,
    output: OpenApiDocumentSchema,
  },
] as const;

type RouteOf<K extends RouteKey> = Extract<(typeof ROUTES)[number], { key: K }>;
export type RouteKey = (typeof ROUTES)[number]["key"];
/** Path parameters and body. */
export type RouteInput<K extends RouteKey> = z.infer<RouteOf<K>["input"]>;
/** The 2xx body. */
export type RouteOutput<K extends RouteKey> = z.infer<RouteOf<K>["output"]>;
