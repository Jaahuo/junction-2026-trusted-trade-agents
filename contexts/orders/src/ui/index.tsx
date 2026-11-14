import { ErrorEnvelopeSchema, type Order, REASON_TEXT } from "@app/contract";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  EmptyState,
  Field,
  PageHeader,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
  toast,
} from "@app/ui";
import {
  ORDER_ACTIONS,
  ORDER_OUTCOMES,
  ORDER_STATUS_LABELS,
  ORDER_TERMS,
  formatDeliveryDate,
  formatMoney,
  formatOrderNumber,
  formatQuantity,
} from "@app/ui/format";
import { apiUrl, type Screen } from "@app/web-kit";
import { treaty } from "@elysia/eden";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Api } from "../api/index.ts";

const api = treaty<Api>(apiUrl, { parseDate: false });

const failures: Record<string, string> = {
  CONFLICT: "This order was already decided or changed. Reload the page to see it.",
  STALE_OFFER: "The mandate changed after the offers were made. Ask the agent for new offers.",
  OFFER_EXPIRED: "An offer in this order has expired. Ask the agent for new offers.",
  UPSTREAM_FAILED: "The mandate could not be read. Try again in a moment.",
  NOT_FOUND: "This order no longer exists.",
};
const explain = (code: string): string => failures[code] ?? "The decision could not be saved.";

const pageOf = (orderId: string): string => `/approvals?order=${encodeURIComponent(orderId)}`;

const statusBadge: Record<
  Order["status"],
  { tone: "info" | "success" | "warning" | "danger"; text: string }
> = {
  pending_approval: { tone: "warning", text: ORDER_STATUS_LABELS.pending_approval },
  awaiting_payment: { tone: "info", text: ORDER_STATUS_LABELS.awaiting_payment },
  placed: { tone: "success", text: ORDER_STATUS_LABELS.placed },
  rejected: { tone: "danger", text: ORDER_STATUS_LABELS.rejected },
  declined: { tone: "danger", text: ORDER_STATUS_LABELS.declined },
};

function Reasons({ order }: { order: Order }) {
  return (
    <ul className="flex flex-col gap-2">
      {order.reasons.map((reason) => (
        <li key={reason} className="flex flex-col gap-0.5" title={reason}>
          <span className="font-medium">{REASON_TEXT[reason]}</span>
        </li>
      ))}
    </ul>
  );
}

function Lines({ order }: { order: Order }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Product</Th>
          <Th>Quantity</Th>
          <Th>Delivery</Th>
          <Th>Total</Th>
        </tr>
      </thead>
      <tbody>
        {order.lines.map(({ offerId, claims }) => (
          <tr key={offerId}>
            <Td>{claims.product.name}</Td>
            <Td title={claims.quantity.unit}>{formatQuantity(claims.quantity)}</Td>
            <Td>{formatDeliveryDate(claims.deliveryDate)}</Td>
            <Td>{formatMoney(claims.total.gross, claims.unitPrice.currency, "gross")}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Outcome({ order }: { order: Order }) {
  if (order.status === "placed")
    return (
      <Alert tone="success" title={ORDER_STATUS_LABELS.placed}>
        {ORDER_OUTCOMES.placed}
      </Alert>
    );
  if (order.status === "declined")
    return (
      <Alert tone="warning" title="Declined">
        {order.decision?.next === "alternatives"
          ? ORDER_OUTCOMES.alternatives
          : ORDER_OUTCOMES.stop}
        {order.decision?.note ? ` Note: ${order.decision.note}` : ""}
      </Alert>
    );
  if (order.status === "rejected")
    return (
      <Alert tone="danger" title="Rejected">
        <span title={order.reasons.join(", ")}>
          {order.reasons.map((reason) => REASON_TEXT[reason]).join(" ")}
        </span>
      </Alert>
    );
  return null;
}

type Decision =
  | { decision: "approve" }
  | { decision: "reject"; next: "stop" | "alternatives"; note?: string };

function OrderReview({ orderId }: { orderId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["orders", orderId];
  const [note, setNote] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const order = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await api.orders({ orderId }).get();
      if (error) {
        if (error.status === 404) return null;
        throw new Error("Unable to load the order.");
      }
      return data;
    },
  });
  const decide = useMutation({
    mutationFn: async ({ proposalVersion, body }: { proposalVersion: number; body: Decision }) => {
      const { data, error } = await api
        .orders({ orderId })
        .decision.post({ proposalVersion, ...body });
      if (error) throw new Error(ErrorEnvelopeSchema.safeParse(error.value).data?.error.code ?? "");
      return data;
    },
    onSuccess: (decided) => {
      setConfirmStop(false);
      queryClient.setQueryData(queryKey, decided);
      void queryClient.invalidateQueries({ queryKey: ["orders", "pending"] });
    },
    onError: (error) => {
      setConfirmStop(false);
      toast.error(explain(error.message));
    },
  });

  if (order.isPending) return <Spinner />;
  if (order.isError)
    return (
      <Alert tone="danger" title="Could not load order">
        Please try again later.
      </Alert>
    );
  const current = order.data;
  if (!current)
    return (
      <EmptyState
        title="Order not found"
        description="The link may be old, or the order belongs to another account."
        action={
          <a className="text-primary" href="/approvals">
            Show orders waiting for approval
          </a>
        }
      />
    );

  const send = (body: Decision) => {
    const trimmed = note.trim();
    decide.mutate({
      proposalVersion: current.proposalVersion,
      body: body.decision === "reject" && trimmed !== "" ? { ...body, note: trimmed } : body,
    });
  };
  const badge = statusBadge[current.status];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>{current.originalRequest ?? "Order request"}</CardTitle>
          <Badge tone={badge.tone}>{badge.text}</Badge>
        </div>
        <p className="text-sm text-muted">
          {formatMoney(current.total.gross, "EUR", "gross")} ·{" "}
          {current.paymentTerms === "invoice" ? "Invoice" : ORDER_TERMS.paymentOnOrder}
        </p>
      </Card>
      <Outcome order={current} />
      <Card>
        <CardTitle>Why it needs approval</CardTitle>
        <Reasons order={current} />
      </Card>
      <Card>
        <CardTitle>Order lines</CardTitle>
        <Lines order={current} />
      </Card>
      {current.status === "pending_approval" ? (
        <Card>
          <CardTitle>Your decision</CardTitle>
          <div className="flex flex-col gap-4">
            <Field label="Note to the agent" hint="Optional. Saved with a rejection.">
              <Textarea
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="danger"
                disabled={decide.isPending}
                onClick={() => {
                  setConfirmStop(true);
                }}
              >
                {ORDER_ACTIONS.rejectStop}
              </Button>
              <Button
                variant="secondary"
                disabled={decide.isPending}
                onClick={() => {
                  send({ decision: "reject", next: "alternatives" });
                }}
              >
                {ORDER_ACTIONS.rejectAlternatives}
              </Button>
              <Button
                loading={decide.isPending}
                onClick={() => {
                  send({ decision: "approve" });
                }}
              >
                {ORDER_ACTIONS.approve}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
      <Dialog
        open={confirmStop}
        onClose={() => {
          setConfirmStop(false);
        }}
        title={`${ORDER_ACTIONS.rejectStop}?`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmStop(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={decide.isPending}
              onClick={() => {
                send({ decision: "reject", next: "stop" });
              }}
            >
              {ORDER_ACTIONS.rejectStop}
            </Button>
          </>
        }
      >
        {ORDER_OUTCOMES.stop}
      </Dialog>
    </div>
  );
}

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
  const orderId = new URLSearchParams(window.location.search).get("order");
  return (
    <>
      <PageHeader
        title="Approvals"
        description={`Orders that exceed an ${ORDER_TERMS.limit.toLowerCase()} wait here for a human decision.`}
      />
      {orderId === null ? <PendingOrders /> : <OrderReview orderId={orderId} />}
    </>
  );
}

export const screen: Screen = {
  path: "/approvals",
  title: "Approvals",
  Component: ApprovalsScreen,
};
