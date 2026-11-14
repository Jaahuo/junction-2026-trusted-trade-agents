import { brand } from "@app/ui/brand";
import "../view.css";
import { mountView } from "../../shared/view-element.ts";
import { defineApprovalView } from "./approval-view.ts";

defineApprovalView();
document.title = `Approvals | ${brand.name}`;
const view = document.createElement("tt-approval-view");
view.addEventListener("tt-approval-selection", (event) => {
  if (!(event instanceof CustomEvent)) return;
  const orderId: unknown = event.detail;
  if (orderId !== null && typeof orderId !== "string") return;
  document.title = `${orderId === null ? "Approvals" : `Approval ${orderId}`} | ${brand.name}`;
});
mountView(view);
