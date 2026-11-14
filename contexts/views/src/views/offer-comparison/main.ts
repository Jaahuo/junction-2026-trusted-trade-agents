import "../view.css";
import { mountView } from "../../shared/view-element.ts";
import { defineOfferComparison } from "./offer-comparison.ts";

defineOfferComparison();
mountView(document.createElement("tt-offer-comparison"));
