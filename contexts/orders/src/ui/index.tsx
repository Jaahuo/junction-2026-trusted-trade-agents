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

const euro = (value: number): string =>
  new Intl.NumberFormat("en-FI", { style: "currency", currency: "EUR" }).format(value);

const pageOf = (orderId: string): string => `/approvals?order=${encodeURIComponent(orderId)}`;

const statusBadge: Record<
  Order["status"],
  { tone: "info" | "success" | "warning" | "danger"; text: string }
> = {
  pending_approval: { tone: "warning", text: "Waiting for approval" },
  awaiting_payment: { tone: "info", text: "Awaiting payment" },
  placed: { tone: "success", text: "Placed" },
  rejected: { tone: "danger", text: "Rejected" },
  declined: { tone: "danger", text: "Declined" },
};

function Reasons({ order }: { order: Order }) {
  return (
    <ul className="flex flex-col gap-2">
      {order.reasons.map((reason) => (
        <li key={reason} className="flex flex-col gap-0.5">
          <span className="font-medium">{REASON_TEXT[reason]}</span>
          <span className="text-sm text-muted">{reason}</span>
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
            <Td>
              {claims.quantity.value} {claims.quantity.unit}
            </Td>
            <Td>{claims.deliveryDate}</Td>
            <Td>{euro(claims.total.gross)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Outcome({ order }: { order: Order }) {
  if (order.status === "placed")
    return (
      <Alert tone="success" title="Approved and placed">
        The order is placed at the offered price and delivery date.
      </Alert>
    );
  if (order.status === "declined")
    return (
      <Alert tone="warning" title="Declined">
        {order.decision?.next === "alternatives"
          ? "The agent may look for alternatives."
          : "The agent stops and tells the buyer."}
        {order.decision?.note ? ` Note: ${order.decision.note}` : ""}
      </Alert>
    );
  if (order.status === "rejected")
    return (
      <Alert tone="danger" title="Rejected">
        {order.reasons.map((reason) => REASON_TEXT[reason]).join(" ")}
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
      if (error) return null;
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
          {euro(current.total.gross)} incl. VAT ·{" "}
          {current.paymentTerms === "invoice" ? "Invoice" : "Pay on order"}
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
                Reject and stop
              </Button>
              <Button
                variant="secondary"
                disabled={decide.isPending}
                onClick={() => {
                  send({ decision: "reject", next: "alternatives" });
                }}
              >
                Reject, allow alternatives
              </Button>
              <Button
                loading={decide.isPending}
                onClick={() => {
                  send({ decision: "approve" });
                }}
              >
                Approve
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
        title="Reject and stop?"
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
              Reject and stop
            </Button>
          </>
        }
      >
        The order is declined and the agent stops looking for this purchase.
      </Dialog>
    </div>
  );
}

function PendingOrders() {
  const pending = useQuery({
    queryKey: ["orders", "pending"],
    queryFn: async () => (await api.orders.pending.get()).data?.orders ?? [],
  });
  if (pending.isPending) return <Spinner />;
  if (!pending.data || pending.data.length === 0)
    return (
      <EmptyState
        title="No orders wait for approval"
        description="When an agent's order breaks a limit, it appears here for a decision."
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
              <Td>{order.originalRequest ?? order.orderId}</Td>
              <Td>{euro(order.total.gross)}</Td>
              <Td>{order.reasons.map((reason) => REASON_TEXT[reason]).join(" ")}</Td>
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
        description="Orders that broke a limit wait here for a human decision."
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
