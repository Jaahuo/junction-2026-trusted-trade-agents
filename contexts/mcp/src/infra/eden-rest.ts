import { type ErrorEnvelope, ErrorEnvelopeSchema, TOOL_OUTPUT } from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { selfBaseUrl } from "@app/server-kit";
import type { Api as CatalogApi } from "@ctx/catalog/api";
import type { Api as MandatesApi } from "@ctx/mandates/api";
import type { Api as OffersApi } from "@ctx/offers/api";
import type { Api as OrdersApi } from "@ctx/orders/api";
import { treaty } from "@elysia/eden";
import type { z } from "zod";
import type { TradeRest } from "../application/tools.ts";

interface EdenReply {
  readonly data: unknown;
  readonly error: { readonly status: unknown; readonly value: unknown } | null;
}

const upstreamFailed = (message: string): ErrorEnvelope => ({
  error: { code: "UPSTREAM_FAILED", message },
});

const settle = async <T>(
  route: string,
  output: z.ZodType<T>,
  request: () => Promise<EdenReply>,
): Promise<Result<T, ErrorEnvelope>> => {
  let reply: EdenReply;
  try {
    reply = await request();
  } catch (error) {
    // Eden rejects when a response body is not the JSON its content type claims.
    const reason = error instanceof Error ? error.message : String(error);
    return err(upstreamFailed(`${route} answered a response that cannot be read: ${reason}`));
  }
  if (reply.error !== null) {
    const envelope = ErrorEnvelopeSchema.safeParse(reply.error.value);
    return err(
      envelope.success
        ? envelope.data
        : upstreamFailed(
            `${route} answered ${String(reply.error.status)} without an error envelope.`,
          ),
    );
  }
  const body = output.safeParse(reply.data);
  return body.success
    ? ok(body.data)
    : err(upstreamFailed(`${route} answered a body that does not match its schema.`));
};

/** Calls the peer contexts' routes through Eden clients on `<base>/api`. */
export const edenTradeRest = (
  baseUrl: () => string = selfBaseUrl,
  fetcher: typeof fetch = fetch,
): TradeRest => {
  const options = { parseDate: false, fetcher } as const;
  const catalog = () => treaty<CatalogApi>(`${baseUrl()}/api`, options).catalog;
  const offers = () => treaty<OffersApi>(`${baseUrl()}/api`, options).offers;
  const orders = () => treaty<OrdersApi>(`${baseUrl()}/api`, options).orders;
  const mandates = () => treaty<MandatesApi>(`${baseUrl()}/api`, options).mandates;
  return {
    search: (body) =>
      settle("search", TOOL_OUTPUT.search_products, () => catalog().search.post(body)),
    offers: (body) => settle("offers", TOOL_OUTPUT.get_offers, () => offers().post(body)),
    place: (body) => settle("place", TOOL_OUTPUT.place_order, () => orders().post(body)),
    status: (orderId) =>
      settle("status", TOOL_OUTPUT.get_order_status, () => orders()({ orderId }).get()),
    mandate: () => settle("mandate", TOOL_OUTPUT.get_mandate, () => mandates().current.get()),
    draft: (body) => settle("draft", TOOL_OUTPUT.draft_mandate, () => mandates().drafts.post(body)),
    pending: () =>
      settle("pending", TOOL_OUTPUT.list_pending_approvals, () => orders().pending.get()),
    decide: (orderId, body) =>
      settle("decide", TOOL_OUTPUT.decide_approval, () =>
        orders()({ orderId }).decision.post(body),
      ),
    register: (body) =>
      settle("register", TOOL_OUTPUT.register_mandate, () => mandates().post(body)),
    revoke: (mandateId) =>
      settle("revoke", TOOL_OUTPUT.revoke_mandate, () => mandates()({ mandateId }).revoke.post({})),
  };
};
