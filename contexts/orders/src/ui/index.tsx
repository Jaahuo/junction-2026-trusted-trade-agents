import { EmptyState, PageHeader } from "@app/ui";
import type { Screen } from "@app/web-kit";

function ApprovalsScreen() {
  return (
    <>
      <PageHeader title="Approvals" description="Orders that wait for a human decision." />
      <EmptyState
        title="Approvals are not built yet"
        description="The orders issue replaces this placeholder with the approval page."
      />
    </>
  );
}

export const screen: Screen = {
  path: "/approvals",
  title: "Approvals",
  Component: ApprovalsScreen,
};
