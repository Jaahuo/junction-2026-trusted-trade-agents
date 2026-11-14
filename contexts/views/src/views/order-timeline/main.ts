import "../view.css";
import { mountView } from "../../shared/view-element.ts";
import { defineOrderTimeline } from "./order-timeline.ts";

defineOrderTimeline();
mountView(document.createElement("tt-order-timeline"));
