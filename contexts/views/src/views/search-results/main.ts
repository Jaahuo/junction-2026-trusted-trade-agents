import "../view.css";
import { mountView } from "../../shared/view-element.ts";
import { defineSearchResults } from "./search-results.ts";

defineSearchResults();
mountView(document.createElement("tt-search-results"));
