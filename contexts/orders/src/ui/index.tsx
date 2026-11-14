import { Spinner } from "@app/ui";
import type { Screen } from "@app/web-kit";
import { useEffect } from "react";

/**
 * The approval page forwards to the approval card, the same web component as in the chat (the
 * views' plain mode): the list of open orders, or one order with ?order=<id> (the approvalUrl).
 */
const cardPage = (orderId: string | null): string =>
  orderId === null
    ? "/views/approval-card"
    : `/views/approval-card?order=${encodeURIComponent(orderId)}`;

function ApprovalsScreen() {
  const orderId = new URLSearchParams(window.location.search).get("order");
  useEffect(() => {
    window.location.replace(cardPage(orderId));
  }, [orderId]);
  return <Spinner />;
}

export const screen: Screen = {
  path: "/approvals",
  title: "Approvals",
  Component: ApprovalsScreen,
};
