import { REASON_TEXT, type Order } from "@app/contract";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
} from "@app/ui";
import {
  formatMoney,
  formatOrderNumber,
  formatTimestamp,
  ORDER_STATUS_LABELS,
} from "@app/ui/format";
import { apiUrl, type Screen } from "@app/web-kit";
import { treaty } from "@elysia/eden";
import { useQuery } from "@tanstack/react-query";
import type { Api } from "../api/index.ts";

const api = treaty<Api>(apiUrl, { parseDate: false });

const statusTones = {
  pending_approval: "warning",
  awaiting_payment: "info",
  placed: "success",
  rejected: "danger",
  declined: "danger",
} as const satisfies Record<Order["status"], "warning" | "info" | "success" | "danger">;

function ActivityScreen() {
  const orders = useQuery({
    queryKey: ["activity", "orders"],
    queryFn: async () => {
      const { data, error } = await api.orders.get();
      if (error !== null || data === null) throw new Error("Could not load orders.");
      return data.orders;
    },
  });
  const refusals = useQuery({
    queryKey: ["activity", "refusals"],
    queryFn: async () => {
      const { data, error } = await api.orders.refusals.get();
      if (error !== null || data === null) throw new Error("Could not load refusals.");
      return data.refusals;
    },
  });

  return (
    <>
      <PageHeader
        title="Agent activity"
        description="Wholesaler view of activity for the single demo customer. This role is separated by route only, not authentication."
        actions={
          <Button
            variant="secondary"
            loading={orders.isFetching || refusals.isFetching}
            onClick={() => {
              void orders.refetch();
              void refusals.refetch();
            }}
          >
            Refresh activity
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        <Card>
          <CardTitle>Orders</CardTitle>
          {orders.isPending ? (
            <p>
              <Spinner /> Loading orders...
            </p>
          ) : orders.isError ? (
            <Alert tone="danger">Could not load orders. Refresh activity to try again.</Alert>
          ) : orders.data.length === 0 ? (
            <EmptyState
              title="No orders yet"
              description="Orders for the demo customer will appear here."
            />
          ) : (
            <Table className="block md:table">
              <thead className="hidden md:table-header-group">
                <tr>
                  <Th>Time</Th>
                  <Th>Order</Th>
                  <Th>Agent</Th>
                  <Th>Status</Th>
                  <Th>Reasons</Th>
                  <Th>Total</Th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {orders.data.map((order) => (
                  <tr key={order.orderId} className="block md:table-row">
                    <Td className="block md:table-cell">
                      <span className="md:hidden">Time: </span>
                      {formatTimestamp(order.createdAt)}
                    </Td>
                    <Td className="block md:table-cell break-words">
                      <a
                        className="text-primary underline"
                        href={`/views/order-timeline?order=${encodeURIComponent(order.orderId)}`}
                      >
                        Order {formatOrderNumber(order.orderId)}
                      </a>
                      {order.purpose ? <p>{order.purpose}</p> : null}
                      {order.lines.map((line) => (
                        <p key={line.offerId}>{line.claims.product.name}</p>
                      ))}
                    </Td>
                    <Td className="block md:table-cell break-all">
                      <span className="md:hidden">Agent: </span>
                      {order.agentId}
                    </Td>
                    <Td className="block md:table-cell">
                      <span className="md:hidden">Status: </span>
                      <Badge tone={statusTones[order.status]}>
                        {ORDER_STATUS_LABELS[order.status]}
                      </Badge>
                    </Td>
                    <Td className="block md:table-cell break-words">
                      <span className="md:hidden">Reasons: </span>
                      {order.reasons.length === 0
                        ? "None"
                        : order.reasons.map((reason) => (
                            <p key={reason}>
                              {reason}: {REASON_TEXT[reason]}
                            </p>
                          ))}
                    </Td>
                    <Td className="block md:table-cell">
                      <span className="md:hidden">Total: </span>
                      {formatMoney(order.total.gross, "EUR", "gross")}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardTitle>Refused attempts</CardTitle>
          <p className="mb-4 text-muted">Refresh after a refused attempt to see it here.</p>
          {refusals.isPending ? (
            <p>
              <Spinner /> Loading refused attempts...
            </p>
          ) : refusals.isError ? (
            <Alert tone="danger">
              Could not load refused attempts. Refresh activity to try again.
            </Alert>
          ) : refusals.data.length === 0 ? (
            <EmptyState
              title="No refused attempts"
              description="Refused attempts for the demo customer will appear here."
            />
          ) : (
            <Table className="block md:table">
              <thead className="hidden md:table-header-group">
                <tr>
                  <Th>Time</Th>
                  <Th>Code</Th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {refusals.data.map((refusal) => (
                  <tr key={refusal.id} className="block md:table-row">
                    <Td className="block md:table-cell">
                      <span className="md:hidden">Time: </span>
                      {formatTimestamp(refusal.at)}
                    </Td>
                    <Td className="block md:table-cell break-words">
                      <span className="md:hidden">Code: </span>
                      {refusal.code}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

export const screen: Screen = {
  path: "/activity",
  title: "Agent activity",
  Component: ActivityScreen,
};
