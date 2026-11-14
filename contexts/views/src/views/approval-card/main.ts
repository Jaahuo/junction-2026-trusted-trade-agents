import "../view.css";
import { mountView } from "../../shared/view-element.ts";
import { defineApprovalView } from "./approval-view.ts";

defineApprovalView();
mountView(document.createElement("tt-approval-view"));
