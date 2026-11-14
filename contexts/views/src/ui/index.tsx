import { Spinner } from "@app/ui";
import type { Screen } from "@app/web-kit";
import { useEffect, useRef } from "react";
import { pageSource } from "../shared/source.ts";
import { defineApprovalView } from "../views/approval-card/approval-view.ts";

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

/**
 * The approval card view inside the app: the open orders, or one order. Opening an order and
 * going back change the app's address, so the top bar and the browser's back button follow.
 */
function ApprovalsScreen() {
  const { orderId, redirect } = approvalRoute(window.location.pathname, window.location.search);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (redirect !== null) {
      window.location.replace(redirect);
      return undefined;
    }
    defineApprovalView();
    const view = document.createElement("tt-approval-view");
    view.inApp = true;
    view.source = pageSource(
      "approval-card",
      new URLSearchParams(orderId === null ? {} : { order: orderId }),
    );
    view.addEventListener("tt-approval-navigate", (event) => {
      const next: unknown = event instanceof CustomEvent ? event.detail : null;
      // wouter follows pushState, so the matching route renders this screen again.
      history.pushState(null, "", typeof next === "string" ? pageOf(next) : "/approvals");
      window.scrollTo({ top: 0 });
    });
    host.current?.replaceChildren(view);
    return () => view.remove();
  }, [orderId, redirect]);
  if (redirect !== null) return <Spinner />;
  return <div ref={host} className="mx-auto -mt-3 max-w-xl" />;
}

export const screen: Screen = {
  path: "/approvals/:orderId?",
  href: "/approvals",
  title: "Approvals",
  Component: ApprovalsScreen,
};
