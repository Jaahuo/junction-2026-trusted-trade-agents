import {
  type ErrorEnvelope,
  type OffersResult,
  type Order,
  type PendingList,
  type Quantity,
  REASON_TEXT,
  type ReasonCode,
  type SearchResult,
  type StoredMandate,
} from "@app/contract";

const quantity = (value: Quantity): string => `${value.value} ${value.unit}`;
const reasons = (codes: readonly ReasonCode[]): string[] =>
  codes.map((code) => `- ${code}: ${REASON_TEXT[code]}`);
const lines = (...parts: (string | string[])[]): string => parts.flat().join("\n");

export const searchSummary = (result: SearchResult): string =>
  lines(
    `${result.candidates.length} candidate products.`,
    result.candidates.map(
      (candidate) =>
        `- ${candidate.productId}: ${candidate.name}` +
        (candidate.orderQuantity === null ? "" : `, order ${quantity(candidate.orderQuantity)}`),
    ),
  );

export const offersSummary = (result: OffersResult): string =>
  lines(
    `${result.offers.length} signed offers, ${result.omitted.length} products omitted.`,
    result.offers.map(
      ({ offerId, claims, precheck }) =>
        `- ${offerId}: ${claims.product.name}, ${quantity(claims.quantity)}, ` +
        `${claims.total.gross.toFixed(2)} EUR gross, delivery ${claims.deliveryDate}` +
        (precheck === null ? "" : `, pre-check ${precheck.decision}`),
    ),
    result.omitted.map(
      ({ productId, reason, detail }) => `- ${productId} omitted: ${reason}. ${detail}`,
    ),
  );

const approvalLine = (order: Order): string[] =>
  order.status === "pending_approval" && order.approvalUrl !== null
    ? [`A human approves or rejects it at ${order.approvalUrl}`]
    : [];

export const orderSummary = (order: Order): string =>
  lines(
    `Order ${order.orderId}: ${order.status}, ${order.total.gross.toFixed(2)} EUR gross, proposal version ${order.proposalVersion}.`,
    reasons(order.reasons),
    approvalLine(order),
  );

export const pendingSummary = (list: PendingList): string =>
  lines(
    `${list.orders.length} orders wait for approval.`,
    list.orders.map(
      (order) =>
        `- ${order.orderId}: ${order.total.gross.toFixed(2)} EUR gross` +
        (order.approvalUrl === null ? "" : `, approve at ${order.approvalUrl}`),
    ),
  );

export const mandateSummary = ({ mandate, status }: StoredMandate): string =>
  `Mandate ${mandate.mandateId} version ${mandate.version}: ${status}. ` +
  `Maximum order total ${mandate.limits.maxOrderTotal.value.toFixed(2)} EUR gross.`;

export const errorSummary = ({ error }: ErrorEnvelope): string =>
  `${error.code}: ${error.message}` +
  (error.nextDeliveryDate === undefined ? "" : ` Next delivery date: ${error.nextDeliveryDate}.`);
