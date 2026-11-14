import "../view.css";
import { mountView } from "../../shared/view-element.ts";
import { defineApprovalCard } from "./approval-card.ts";

defineApprovalCard();
mountView(document.createElement("tt-approval-card"));
