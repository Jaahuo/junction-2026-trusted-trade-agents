# Offer comparison

A read-only view shown after `get_offers`, before any order exists. It shows each requested line, the offer the agent would order and what would happen if it did. Approval happens later, on the approval card.

- **Header:** the petrol Valio Aimo bar with the number of products, the requested date and when the offers expire ("5 products · Mon 23 Nov", "until 23:32").
- **Glance:** one row per requested line; two lines of the same product are two rows. Each row has a status icon: a check (no approval needed for this product), a triangle (needs a look) or a dash (not offered). Then the product, a short reason when something needs a look ("Over limit", "2 days late", "64 of 80 l", "Not available"), the price per litre or kilogram ("€8.40/kg": total net / (quantity × pack size), "—" when the pack size is unknown, none on a row that is not offered) and a chevron. A pre-check that asks for approval or rejects always shows the triangle, even without a reason code.
- **One product open:** the catalogue name when it differs from the row, one sentence from the pre-check, and the links "Details" and "Other options (N)". An order over the mandate's limit names the amount: "Needs your approval: €18 over your order limit." Only one product is open at a time, and its content follows its row.
- **Other options:** the agent's pick, marked "Pick", then substitutes, best first, with the rank in words and how they differ ("+2 pts reliability · €0.20/kg dearer"). A substitute has a "Use" link unless its pre-check would reject it. Its name opens its own details. "Ask for something else" ends the list.
- **Details:** totals (net, and gross incl. VAT and deposits when there are deposits), deposits, amount, pack, price per l/kg, delivery date, order cut-off, stock, reliability, CO2 (product-group average, kg CO2-eq/kg), origin and the approval. A missing value reads "No data", never 0.
- **Under the products:** each product is checked on its own, so a line says the whole order is checked again when it is placed, and by how much the order is over the limit when the limit is known.
- **Steering:** "Use", "Ask for something else" and "Try again" (for an offer whose pre-check did not answer) post a user message to the chat through the host (`ui/message`); the agent answers it. The view never orders or approves. The link stays the same button: it reads "Asked ✓" once the chat took the message, and the other steering links wait while a message is on its way. A message the chat did not take shows why under its product. When the view has no chat (a source without `message`), the steering links are not shown.
- **No offers:** the shared shell reports a result without offers as empty. This view keeps the products left out and lists each with its reason.

The order limit comes from `get_mandate`, as on the approval card; without it the sentence names no amount.

With the app running, open `/views/harness?view=offer-comparison` to inspect the fixture states: `loading`, `empty`, `error`, `offers` and `substitutes`. The fixtures use invented products.

Screenshots (400 px, chat width): `screenshots/offers-*.png`. `offers-open-fi.png` is the same state in Finnish.

Every text the view shows is in `strings.ts`, in English and Finnish; the view follows the language the shared shell picks (the tool input, the host, then the browser).
