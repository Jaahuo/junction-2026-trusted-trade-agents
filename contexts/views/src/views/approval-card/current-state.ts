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

/** How long after its last change a shown order counts as current without a read. */
const FRESH_MS = 120_000;

const changedAt = (order: Order) =>
  Math.max(
    Date.parse(order.createdAt),
    ...order.audit.map((event) => Date.parse(event.at)),
    order.decision === null ? Number.NEGATIVE_INFINITY : Date.parse(order.decision.at),
  );

/**
 * True when every shown order changed within the last two minutes: the tool has just run, so a
 * read gives the same data and costs the approver a host confirmation.
 */
export const isFresh = (data: Order | PendingList, now: number) =>
  ordersOf(data).every((order) => Math.abs(now - changedAt(order)) < FRESH_MS);

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

type Page = EventTarget & { readonly visibilityState: DocumentVisibilityState };

/**
 * Runs `read` when the page becomes visible again, at most one run at a time. It does not listen
 * for window focus: a host that confirms each tool call returns focus to the view when its dialog
 * closes, so a re-read on focus asks for confirmation again without end.
 */
export function onReturn(page: Page, read: () => Promise<void>) {
  let running = false;
  const listener = () => {
    if (running || page.visibilityState === "hidden") return;
    running = true;
    void read().finally(() => (running = false));
  };
  page.addEventListener("visibilitychange", listener);
  return () => page.removeEventListener("visibilitychange", listener);
}
