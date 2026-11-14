# Order timeline

The timeline shows the order status, gross total, and lines. Each line shows the product, quantity, and delivery date. The timeline lists audit events in their recorded order. Each event includes its actor, timestamp, and any recorded reason or detail. Requoted offers show the product, old and new net unit prices, gross totals, and reasons. A rejection decision shows the next step and any note. This view has no approval actions.

The view uses `@app/ui` for shared order wording and formatting. It uses the `en-FI` locale and displays timestamps in UTC. Delivery dates include the weekday. The full order ID, product IDs, quantity unit codes, and rule codes are available in support titles rather than visible text.

The shared view shell handles loading and errors. The timeline supports pending approval, awaiting payment, placed, rejected, and declined orders.

With the app running, open `/views/harness?view=order-timeline` to see the available fixture states. Open `/views/harness?view=order-timeline&state=done`, `&state=loading`, or `&state=error` to inspect a single state. Resize the view to 400 pixels to check the narrow layout.
