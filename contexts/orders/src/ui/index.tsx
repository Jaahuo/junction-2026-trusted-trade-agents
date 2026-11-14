import { REASON_TEXT } from "@app/contract";
import { Alert, Card, EmptyState, PageHeader, Spinner, Table, Td, Th } from "@app/ui";
import { ORDER_TERMS, formatMoney, formatOrderNumber } from "@app/ui/format";
import { apiUrl, type Screen } from "@app/web-kit";
import { treaty } from "@elysia/eden";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Api } from "../api/index.ts";

const api = treaty<Api>(apiUrl, { parseDate: false });

/**
 * One order opens on its own page as the approval card, the same web component as in the
 * chat (the views' plain mode), so the page and the MCP app show one design.
 */
const pageOf = (orderId: string): string =>
  `/views/approval-card?order=${encodeURIComponent(orderId)}`;

function PendingOrders() {
  const pending = useQuery({
    queryKey: ["orders", "pending"],
    queryFn: async () => {
      const { data, error } = await api.orders.pending.get();
      if (error) throw new Error("Unable to load orders.");
      return data.orders;
    },
  });
  if (pending.isPending) return <Spinner />;
  if (pending.isError)
    return (
      <Alert tone="danger" title="Could not load orders">
        Please try again later.
      </Alert>
    );
  if (!pending.data || pending.data.length === 0)
    return (
      <EmptyState
        title="No orders wait for approval"
        description={`When an agent's order breaks an ${ORDER_TERMS.limit.toLowerCase()}, it appears here for a decision.`}
      />
    );
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>Request</Th>
            <Th>Total</Th>
            <Th>Reasons</Th>
            <Th>Action</Th>
          </tr>
        </thead>
        <tbody>
          {pending.data.map((order) => (
            <tr key={order.orderId}>
              <Td>{order.originalRequest ?? formatOrderNumber(order.orderId)}</Td>
              <Td>{formatMoney(order.total.gross, "EUR", "gross")}</Td>
              <Td title={order.reasons.join(", ")}>
                {order.reasons.map((reason) => REASON_TEXT[reason]).join(" ")}
              </Td>
              <Td>
                <a className="text-primary" href={pageOf(order.orderId)}>
                  Review
                </a>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function ApprovalsScreen() {
  // An order link (approvalUrl) opens that order's approval card.
  const orderId = new URLSearchParams(window.location.search).get("order");
  useEffect(() => {
    if (orderId !== null) window.location.replace(pageOf(orderId));
  }, [orderId]);
  return (
    <>
      <PageHeader
        title="Approvals"
        description={`Orders that exceed an ${ORDER_TERMS.limit.toLowerCase()} wait here for a human decision.`}
      />
      {orderId === null ? <PendingOrders /> : <Spinner />}
    </>
  );
}

export const screen: Screen = {
  path: "/approvals",
  title: "Approvals",
  Component: ApprovalsScreen,
};
