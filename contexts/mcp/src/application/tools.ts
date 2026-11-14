import {
  type DecideApprovalRequest,
  DecideApprovalRequestSchema,
  type ErrorEnvelope,
  TOOL_INPUT,
  type TOOL_OUTPUT,
  type ToolName,
  type VIEWS,
} from "@app/contract";
import { err, type Result } from "@app/kernel";
import type { z } from "zod";
import {
  draftSummary,
  errorSummary,
  mandateSummary,
  offersSummary,
  orderSummary,
  pendingSummary,
  searchSummary,
} from "../domain/summary.ts";

type ToolInput<T extends ToolName> = z.infer<(typeof TOOL_INPUT)[T]>;
type ToolOutput<T extends ToolName> = z.infer<(typeof TOOL_OUTPUT)[T]>;
type Reply<T extends ToolName> = Promise<Result<ToolOutput<T>, ErrorEnvelope>>;

/** The SPEC-003 REST routes behind the tools. Path parameters are separate arguments. */
export interface TradeRest {
  search(body: ToolInput<"search_products">): Reply<"search_products">;
  offers(body: ToolInput<"get_offers">): Reply<"get_offers">;
  place(body: ToolInput<"place_order">): Reply<"place_order">;
  status(orderId: string): Reply<"get_order_status">;
  mandate(): Reply<"get_mandate">;
  draft(body: ToolInput<"draft_mandate">): Reply<"draft_mandate">;
  pending(): Reply<"list_pending_approvals">;
  decide(orderId: string, body: DecideApprovalRequest): Reply<"decide_approval">;
  register(body: ToolInput<"register_mandate">): Reply<"register_mandate">;
  revoke(mandateId: string): Reply<"revoke_mandate">;
}

export type ViewName = (typeof VIEWS)[number]["view"];

/** The HTML of `GET /views/<view>` (SPEC-013). */
export interface ViewPages {
  html(view: ViewName): Promise<Result<string, "NOT_FOUND" | "UPSTREAM_FAILED">>;
}

interface Tool<T extends ToolName> {
  input: z.ZodType<ToolInput<T>>;
  call(rest: TradeRest, input: ToolInput<T>): Reply<T>;
  text(output: ToolOutput<T>): string;
}

const badRequest = (message: string): ErrorEnvelope => ({
  error: { code: "BAD_REQUEST", message },
});

const issueText = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (issue === undefined) return "The input is not valid.";
  return issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`;
};

const decide = (
  rest: TradeRest,
  { orderId, ...fields }: ToolInput<"decide_approval">,
): Reply<"decide_approval"> => {
  const body = DecideApprovalRequestSchema.safeParse(fields);
  return body.success
    ? rest.decide(orderId, body.data)
    : Promise.resolve(err(badRequest(issueText(body.error))));
};

// A quiet twin (SPEC-012) calls the same route as the tool with the view.
const TOOLS: { [T in ToolName]: Tool<T> } = {
  search_products: {
    input: TOOL_INPUT.search_products,
    call: (rest, input) => rest.search(input),
    text: searchSummary,
  },
  find_products: {
    input: TOOL_INPUT.find_products,
    call: (rest, input) => rest.search(input),
    text: searchSummary,
  },
  get_offers: {
    input: TOOL_INPUT.get_offers,
    call: (rest, input) => rest.offers(input),
    text: offersSummary,
  },
  quote_offers: {
    input: TOOL_INPUT.quote_offers,
    call: (rest, input) => rest.offers(input),
    text: offersSummary,
  },
  place_order: {
    input: TOOL_INPUT.place_order,
    call: (rest, input) => rest.place(input),
    text: orderSummary,
  },
  get_order_status: {
    input: TOOL_INPUT.get_order_status,
    call: (rest, { orderId }) => rest.status(orderId),
    text: orderSummary,
  },
  get_mandate: {
    input: TOOL_INPUT.get_mandate,
    call: (rest) => rest.mandate(),
    text: mandateSummary,
  },
  show_mandate: {
    input: TOOL_INPUT.show_mandate,
    call: (rest) => rest.mandate(),
    text: mandateSummary,
  },
  draft_mandate: {
    input: TOOL_INPUT.draft_mandate,
    call: (rest, input) => rest.draft(input),
    text: draftSummary,
  },
  list_pending_approvals: {
    input: TOOL_INPUT.list_pending_approvals,
    call: (rest) => rest.pending(),
    text: pendingSummary,
  },
  decide_approval: { input: TOOL_INPUT.decide_approval, call: decide, text: orderSummary },
  register_mandate: {
    input: TOOL_INPUT.register_mandate,
    call: (rest, input) => rest.register(input),
    text: mandateSummary,
  },
  revoke_mandate: {
    input: TOOL_INPUT.revoke_mandate,
    call: (rest, { mandateId }) => rest.revoke(mandateId),
    text: mandateSummary,
  },
};

export type ToolReply<T extends ToolName> =
  | { readonly isError: false; readonly text: string; readonly data: ToolOutput<T> }
  | { readonly isError: true; readonly text: string; readonly data: ErrorEnvelope };

const failure = (error: ErrorEnvelope): ToolReply<never> => ({
  isError: true,
  text: errorSummary(error),
  data: error,
});

/** Validates the input, calls the tool's REST route and summarizes the 2xx body or the error envelope as text. */
export const runTool = async <T extends ToolName>(
  rest: TradeRest,
  name: T,
  input: unknown,
): Promise<ToolReply<T>> => {
  const tool: Tool<T> = TOOLS[name];
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return failure(badRequest(issueText(parsed.error)));
  const result = await tool.call(rest, parsed.data);
  return result.ok
    ? { isError: false, text: tool.text(result.value), data: result.value }
    : failure(result.error);
};
