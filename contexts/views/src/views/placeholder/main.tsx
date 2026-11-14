import "../view.css";
import { EmptyState } from "@app/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Proves the single-file view build until the views issue adds the real views.
const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <EmptyState title="Placeholder view" description="The views issue replaces this view." />
    </StrictMode>,
  );
}
