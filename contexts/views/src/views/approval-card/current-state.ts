import type { Order, PendingList } from "@app/contract";
import { callAction, type Source } from "../../shared/bridge.ts";

/** True once an order has left approval: placed, awaiting payment, declined or rejected. */
const decided = (order: Order) => order.status !== "pending_approval";

/**
 * Whether the server's copy of an order replaces the one shown. A decided order never returns to
 * pending, so a pending copy cannot replace a decided one, and among pending copies the higher
 * `proposalVersion` wins. Otherwise the server's copy wins: it is read after the shown one.
 */
export const isNewer = (server: Order, shown: Order) =>
  decided(shown)
    ? decided(server)
    : decided(server) || server.proposalVersion >= shown.proposalVersion;

/** The orders a tool result shows: one order, or the list of open approvals. */
const ordersOf = (data: Order | PendingList) => ("orders" in data ? data.orders : [data]);

/** The shown data with each order replaced by its server copy, where that copy is newer. */
export const withCurrent = (data: Order | PendingList, current: readonly Order[]) => {
  const newest = (shown: Order) => {
    const server = current.find((order) => order.orderId === shown.orderId);
    return server !== undefined && isNewer(server, shown) ? server : shown;
  };
  return "orders" in data ? { orders: data.orders.map(newest) } : newest(data);
};

/**
 * Reads every shown order from the server. A host replays the original tool result on a refresh,
 * so the shown data may be older than the order. Returns the server copies and the ids that could
 * not be read, whose decisions stay locked until a later read succeeds.
 */
export async function readCurrent(source: Source, data: Order | PendingList) {
  const reads = await Promise.all(
    ordersOf(data).map(async (order) => ({
      orderId: order.orderId,
      result: await callAction(
        source,
        "get_order_status",
        { orderId: order.orderId },
        order.approvalUrl,
      ),
    })),
  );
  const current: Order[] = [];
  const unread = new Set<string>();
  for (const { orderId, result } of reads)
    if (result.kind === "done") current.push(result.data);
    else unread.add(orderId);
  return { current, unread };
}
