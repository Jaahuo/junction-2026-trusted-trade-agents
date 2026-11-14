import {
  type ErrorEnvelope,
  type MandateDraft,
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
const euros = (value: number): string => `${value.toFixed(2)} EUR gross`;
const reasons = (codes: readonly ReasonCode[]): string[] =>
  codes.map((code) => `- ${code}: ${REASON_TEXT[code]}`);
const lines = (...parts: (string | string[])[]): string => parts.flat().join("\n");

const availabilityNote = (availability: SearchResult["availability"]): string[] => {
  if (availability === undefined) return [];
  if (!availability.checked) return ["Live availability was not read."];
  return availability.dropped === 0
    ? []
    : [`${availability.dropped} matches left out: they cannot be delivered by the requested date.`];
};

export const searchSummary = (result: SearchResult): string =>
  lines(
    `${result.candidates.length} candidate products.`,
    availabilityNote(result.availability),
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
    order.lines.map(
      ({ claims }) =>
        `- ${claims.product.name} (${claims.productId}): ${quantity(claims.quantity)}, ` +
        `unit price ${claims.unitPrice.net.toFixed(2)} ${claims.unitPrice.currency} net (VAT ${claims.unitPrice.vatRate}%), line price ${euros(claims.total.gross)}, delivery ${claims.deliveryDate}.`,
    ),
    order.originalRequest === null ? [] : [`Original request: ${order.originalRequest}`],
    order.decision === null
      ? []
      : [
          `Decision: ${order.decision.action}; next: ${order.decision.next ?? "none"}.`,
          ...(order.decision.note === null ? [] : [`Note: ${order.decision.note}`]),
          ...(order.decision.next === "stop"
            ? ["Stop and do not look for alternatives."]
            : order.decision.next === "alternatives"
              ? ["Search for alternatives and submit a replacement order for approval."]
              : []),
        ],
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
  `Maximum order total ${euros(mandate.limits.maxOrderTotal.value)}.`;

export const draftSummary = ({ draft, current }: MandateDraft): string =>
  lines(
    `Draft mandate, not registered. Maximum order total ${euros(draft.limits.maxOrderTotal.value)}.`,
    current === null
      ? "There is no current mandate."
      : `The current mandate ${current.mandate.mandateId} version ${current.mandate.version} allows ${euros(current.mandate.limits.maxOrderTotal.value)} and stays in force until the human registers the draft.`,
    "The mandate view shows the draft. Ask the human to check it and press Register there. It is not in force until get_mandate shows it.",
  );

export const errorSummary = ({ error }: ErrorEnvelope): string =>
  `${error.code}: ${error.message}` +
  (error.nextDeliveryDate === undefined ? "" : ` Next delivery date: ${error.nextDeliveryDate}.`);
