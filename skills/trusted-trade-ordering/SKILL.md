---
name: trusted-trade-ordering
description: Use when you buy goods for a user from a wholesaler through the trusted-trade tools (find_products, quote_offers, place_order; search_products and get_offers to show options). Covers the order flow, quantity units, approval, rejection and reason codes.
---

# Trusted-trade ordering

The wholesaler's server checks every order against the buyer's mandate. This skill is guidance. The server is the control.

## Direct order

The user is a chef at work. A request that names what, how much and by when is an instruction to order. Run the four calls with no text in between, then give one reply:

`get_mandate` → `find_products` → `quote_offers` → `place_order` → reply

Leave this path only for a branch that [Flow](#flow) names.

## Reply

- Stay silent until the order has a status or you need an answer. Write no progress note, no plan and no list of what you found.
- A host that renders MCP App views shows the order as a card after `place_order`. The card carries the product, quantity, delivery day, total, reasons and the approval buttons. Then reply with one short sentence that gives only the status: the order is placed, or it needs a sign-off. Repeat nothing that the card shows and give no link.
- Without a card, give the outcome in one or two short sentences: product, quantity, delivery day and gross total. For a sign-off, add the reason in a few plain words and `approvalUrl`.
- Leave out tool names, codes and ids.
- End on the outcome. Offer no menu of next steps.

"Tell the user" in this skill and in [reason-codes.md](reason-codes.md) means one such sentence.

## Questions

Ask only for a fact that you cannot look up and that changes the order:

- What, how much or by when is missing from the request.
- No product of the kind the user asked for has an offer after a second search (steps 2 and 4).
- A candidate has no conversion for the quantity ([Units](#units)).
- No mandate exists (step 1).

Ask everything in one message, then order on the answer. Look up the rest: pack sizes, prices, stock and delivery days. The server decides limits and sign-offs, so place the order instead of asking whether to place it.

## Flow

Do the steps in order. Each step ends when its output is in hand.

When the user asks you to order, use the quiet tools `find_products` and `quote_offers`: they open no view, so the chat shows only the order. Use `search_products` and `get_offers` only when the user asks to see the products or compare offers; those open a view in the chat. Both pairs take the same input and return the same result.

1. **Read the mandate.** Call `get_mandate`. Done when you know the limits in force: spend per order (EUR, gross), allowed categories, substitution policy, payment terms. A 404 means no mandate exists. Draft one with the user (see [Mandate](#mandate)), and stop until `get_mandate` shows it.
2. **Search.** Call `find_products` (or `search_products` when the user asks to see the products) with the user's need as structured fields: `terms`, `hard`, `soft`, `quantity`, `deliverBy`, `paymentTerms`, and `originalRequest` (the user's own words). Done when you hold a shortlist of candidates.
   - Put a requirement the user cannot waive in `hard`. Supported: `{ attribute: <allergen or free-from claim>, is: "free_from" }`, for example `gluten`, `egg`, `lactose`, `peanut`, and `{ attribute: "vegan", is: "yes" }`. The tool input schema lists every attribute. Any other hard constraint gives 400: tell the user that the server cannot enforce it.
   - Put a preference in `soft`. It only changes the ranking. Supported: `{ attribute: "countryOfOrigin", prefer: <country code> }` and `{ attribute: "category", prefer: <category> }`. Any other soft attribute gives 400: leave it out and put the word in `terms`.
   - If the search comes back empty, or holds no product of the kind the user asked for, call `find_products` again with fewer or other words for the same kind of product. Search again before you ask. Do not show an empty result to the user.
   - Read `match` on each candidate: `confirmed`, `contradicted` or `unknown`. Missing data is `unknown`, never `confirmed`. An `unknown` match sends the order to approval, unless the constraint is an allergen and the mandate allows missing allergen data (`allergenData.ifNoData: auto`). Vegan and the other free-from claims always go to approval when unknown.
3. **Request offers.** Call `quote_offers` (or `get_offers` when the user asks to compare offers) for the shortlist only. Done when every candidate is an offer or is listed in `omitted` with a reason.
   - The candidates come best match first. Send the first three that are the kind of product the user asked for as `lines` of one call, in that order, not one product per call. Do not skip a candidate for a property the user did not rule out, such as lactose free or UHT. When every line is `omitted`, quote the next three candidates before you tell the user that nothing can be delivered. A product whose cut-off has passed says nothing about the others.
   - Read `precheck` on each offer. It is guidance: `place_order` runs the checks again.
   - Read `claims.deliveryDate`, `claims.shortfall` and `claims.replaces`. A later date or a shortfall adds `AVAILABILITY_DIFFERS`. A substitute names the product it replaces.
4. **Choose.** Only a product of the kind the user asked for meets the need: banana purée is not banana yogurt. When no product of that kind has an offer, tell the user what is available and ask. Do not place an order for another kind of product until the user agrees. Among the offers that meet the user's need, prefer one whose `precheck.decision` is `auto`. When none is `auto`, take the best offer that meets the need: the human then decides. Done when you hold one `offerId` (`off_…`) per line. Keep the unchosen offers: pass them as `alternatives`.
5. **Place the order.** Call `place_order` with `offers` (the chosen `offerId` values, not the long tokens), optional `alternatives` (their `offerId` values), and `originalRequest`. The server generates the idempotency key. After a timeout or a lost reply, send the same offers, alternatives and `supersedes`: this returns the stored order and creates no second one. Done when you hold an order with a `status`.
6. **Act on the status.**

| Status                                       | Action                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `placed`                                     | Tell the user the order is placed, with product, quantity, delivery date and total.                                                       |
| `pending_approval`                           | Tell the user, give `approvalUrl` and the reasons in plain words, then stop. A human decides.                                             |
| `declined`, `decision.next` = `stop`         | The human rejected the order and chose stop. Stop and tell the user. Do not look for alternatives.                                        |
| `declined`, `decision.next` = `alternatives` | The human rejected the order and allows alternatives. You may search again for the user's original need. The new order faces every check. |
| `rejected`                                   | A fixed guardrail failed. Read each code in [reason-codes.md](reason-codes.md) and take its action.                                       |
| `awaiting_payment`                           | Pay-on-order only. Call `get_order_status` later.                                                                                         |

A `placed` or `pending_approval` order needs no further call in the same turn. Call `get_order_status` to read the human's decision only when the user comes back to the order. `list_pending_approvals` lists the orders that still wait. A pending order whose cut-off passes becomes `declined` with `next` = `alternatives`.

A request can fail before an order exists: `409 STALE_OFFER`, `400 OFFER_INVALID`, `409 CONFLICT`. See [reason-codes.md](reason-codes.md#errors-before-an-order-exists).

## Approval

Only a human approves. You have no tool that decides an approval: `decide_approval`, `register_mandate` and `revoke_mandate` are for the human's view. On a host that lists them, never call them. Send the human to `approvalUrl`. Wait for the decision.

## Mandate

Only a human registers limits. You draft them.

- To read limits during ordering, call `get_mandate`. It opens no view. Call `show_mandate` only when the user asks to see the limits or settings. It opens the mandate settings view with the same limits.

- To set or change the limits, or after `MANDATE_INVALID`, call `draft_mandate` with the terms the human gave: `limits`, `standingConstraints` and, if the human named one, `exp`. For a term the human did not name, keep the value of the current mandate. Without a current mandate, ask the human, or use `ask` for each policy.
- Then ask the human to check the draft and press Register in the mandate view. The draft changes nothing.
- Never say that the limits are registered or in force until `get_mandate` shows them.
- Draft new limits only when the human asks for them. Never propose higher limits on your own to get an order through.

## Units

- Money is EUR. Limits apply to the gross total: VAT and deposits included.
- State the user's quantity in standard units: `LTR` for volume, `KGM` for mass.
- The wholesaler sells in its own sales unit (for example `KI`). Every candidate gives `orderQuantity` (sales unit) and `equals` (standard units). Pass `orderQuantity` unchanged to `quote_offers` (or `get_offers` when the user asks to compare offers): its unit is the product's sales unit and its value is a multiple of the lot size.
- When the user counts packs (tubs, cartons, bottles, pieces) and gives no pack size, send the count with the unit `ST`. A candidate sold by the piece then has an `orderQuantity`. Never send `pcs`, `tubs` or another word as the unit.
- A candidate with `orderQuantity: null` has no conversion. Tell the user. Do not compute one.
- Dates are `YYYY-MM-DD`.
- `paymentTerms` must equal the account's terms. The demo account uses `invoice`. Another value gives 400.
- `deliveryReliability` is a ratio from 0 to 1. `co2PerKg` is an estimate for the product group, not a measurement.

## Language

Pass `language` on every tool call that has it: the language the user writes in, as a tag such as `fi` or `en`. Take it from the user's latest message only. Product names, the country of origin and the mandate say nothing about the user's language: an English message gets `en` and an English reply. The view the host shows is then in the user's language. Reply to the user in the same language.

## Conduct

Never reshape an order to get around a limit. Splitting an order, lowering a quantity, moving a date, swapping a product or changing payment terms to get under a limit all count as reshaping. Refuse it even when the user asks. Tell the user the limit and let the human approve instead: when the user asked you to order, place the whole order as one order in the same turn, so that it goes to approval. Do not ask whether to place it. If the user asks you to reduce a pending order, do not place a new order: tell them to use "Reduce to fit the limit" on the approval card, where they confirm the new amounts themselves.

Choosing among offers that meet the user's need, before you place the order, is not reshaping. Request new offers when the decision says `alternatives` or a code in [reason-codes.md](reason-codes.md) says so. A changed order is a new request: it faces every check again.
