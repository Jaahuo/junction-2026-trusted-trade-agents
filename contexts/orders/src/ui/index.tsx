import { Spinner } from "@app/ui";
import type { Screen } from "@app/web-kit";
import { useEffect } from "react";

const pageOf = (orderId: string): string => `/approvals/${encodeURIComponent(orderId)}`;

export function approvalRoute(pathname: string, search: string) {
  const segment = pathname.match(/^\/approvals\/([^/]+)\/?$/)?.[1];
  if (segment !== undefined) {
    try {
      return { orderId: decodeURIComponent(segment), redirect: null };
    } catch {
      return { orderId: segment, redirect: null };
    }
  }
  const legacyOrderId = new URLSearchParams(search).get("order");
  return {
    orderId: null,
    redirect: legacyOrderId === null ? null : pageOf(legacyOrderId),
  };
}

const cardPage = (orderId: string | null): string =>
  orderId === null
    ? "/views/approval-card"
    : `/views/approval-card?order=${encodeURIComponent(orderId)}`;

function ApprovalsScreen() {
  const { orderId, redirect } = approvalRoute(window.location.pathname, window.location.search);
  useEffect(() => {
    window.location.replace(redirect ?? cardPage(orderId));
  }, [orderId, redirect]);
  return <Spinner />;
}

export const screen: Screen = {
  path: "/approvals/:orderId?",
  href: "/approvals",
  title: "Approvals",
  Component: ApprovalsScreen,
};
