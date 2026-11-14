import { expect, test } from "bun:test";
import type { approvalRoute as ApprovalRoute } from "./index.tsx";

test("legacy approval links redirect to the canonical review while the list remains accessible", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://localhost" } },
  });
  let approvalRoute: typeof ApprovalRoute;
  try {
    // The screen module reads window.location while loading its API client.
    ({ approvalRoute } = await import("./index.tsx"));
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }

  const legacy = approvalRoute("/approvals", "?order=order%20%2F%20123");
  expect(legacy).toEqual({ orderId: null, redirect: "/approvals/order%20%2F%20123" });
  expect(approvalRoute(legacy.redirect ?? "", "")).toEqual({
    orderId: "order / 123",
    redirect: null,
  });
  expect(approvalRoute("/approvals", "")).toEqual({ orderId: null, redirect: null });
  expect(approvalRoute("/approvals/order%20%2F%20123", "?order=other")).toEqual({
    orderId: "order / 123",
    redirect: null,
  });
});
