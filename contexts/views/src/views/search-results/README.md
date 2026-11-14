# Search results

The view shows candidates in the server's order. It lists the merged hard constraints and soft preferences from `SearchResult.constraints`. It does not infer which constraints come from the mandate.

Each candidate shows its match states, the quantity to order and what it equals, delivery reliability, estimated CO₂ per kg and the product ID. Units, countries and attribute keys show in words. An unknown match stays unknown. A missing order quantity shows “Quantity unknown” with the `quantityReason`, and hides any equivalent quantity. The view has no order or approval actions.

The view draws its results and empty state in the Aimo card frame of the approval card. The shared view shell handles loading and errors. The MCP Apps bridge validates the tool result against the search output schema (SPEC-004 and SPEC-013).

With the app running, open `/views/harness?view=search-results` to inspect the fixture states. Use `&state=results`, `&state=no-quantity`, `&state=loading`, `&state=empty` or `&state=error` for one state. The fixtures use invented products. Check the layout at 400 pixels and at laptop width.
