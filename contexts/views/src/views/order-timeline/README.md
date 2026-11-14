# Order timeline

The timeline shows the order status and audit events in their recorded order. Each event includes its actor, local date and time, and any recorded reason, rule, or detail. Requoted offers appear separately with their product, old and new net unit prices, gross totals, and reasons. A recorded rejection decision shows whether the agent must stop or may seek alternatives, plus any note. This view has no approval actions.

The shared view shell handles loading and errors. The timeline supports pending approval, awaiting payment, placed, rejected, and declined orders.

With the app running, open `/views/harness?view=order-timeline` to see the available fixture states. Open `/views/harness?view=order-timeline&state=done`, `&state=loading`, or `&state=error` to inspect a single state. Resize the view to 400 pixels to check the narrow layout.
