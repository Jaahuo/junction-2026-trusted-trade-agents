import "../view.css";
import { mountView } from "../../shared/view-element.ts";
import { defineMandateSettings } from "./mandate-settings.ts";

defineMandateSettings();
mountView(document.createElement("tt-mandate-settings"));
