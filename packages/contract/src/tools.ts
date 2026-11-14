import { EmptySchema } from "./common.ts";
import { DecideApprovalInputSchema } from "./decision.ts";
import {
  DraftMandateRequestSchema,
  MandateDraftSchema,
  MandateRefSchema,
  RegisterMandateRequestSchema,
  StoredMandateSchema,
} from "./mandate.ts";
import { OffersRequestSchema, OffersResultSchema } from "./offers.ts";
import {
  OrderRefSchema,
  OrderSchema,
  PendingListSchema,
  PlaceOrderRequestSchema,
} from "./orders.ts";
import { SearchRequestSchema, SearchResultSchema } from "./search.ts";

/** The model sees these. `find_products` and `quote_offers` are `search_products` and `get_offers` without a view (SPEC-012). */
export const MODEL_TOOLS = [
  "search_products",
  "find_products",
  "get_offers",
  "quote_offers",
  "place_order",
  "get_order_status",
  "get_mandate",
  "draft_mandate",
  "list_pending_approvals",
] as const;
/** Only a view calls these. */
export const VIEW_TOOLS = ["decide_approval", "register_mandate", "revoke_mandate"] as const;
export type ToolName = (typeof MODEL_TOOLS)[number] | (typeof VIEW_TOOLS)[number];

export const TOOL_INPUT = {
  search_products: SearchRequestSchema,
  find_products: SearchRequestSchema,
  get_offers: OffersRequestSchema,
  quote_offers: OffersRequestSchema,
  place_order: PlaceOrderRequestSchema,
  get_order_status: OrderRefSchema,
  get_mandate: EmptySchema,
  draft_mandate: DraftMandateRequestSchema,
  list_pending_approvals: EmptySchema,
  decide_approval: DecideApprovalInputSchema,
  register_mandate: RegisterMandateRequestSchema,
  revoke_mandate: MandateRefSchema,
} as const satisfies Record<ToolName, unknown>;

export const TOOL_OUTPUT = {
  search_products: SearchResultSchema,
  find_products: SearchResultSchema,
  get_offers: OffersResultSchema,
  quote_offers: OffersResultSchema,
  place_order: OrderSchema,
  get_order_status: OrderSchema,
  get_mandate: StoredMandateSchema,
  draft_mandate: MandateDraftSchema,
  list_pending_approvals: PendingListSchema,
  decide_approval: OrderSchema,
  register_mandate: StoredMandateSchema,
  revoke_mandate: StoredMandateSchema,
} as const satisfies Record<ToolName, unknown>;
