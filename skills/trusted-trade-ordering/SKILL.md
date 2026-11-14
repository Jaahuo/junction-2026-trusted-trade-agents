---
name: trusted-trade-ordering
description: Use when you buy goods for a user from a wholesaler through the trusted-trade tools (search_products, get_offers, place_order). Covers the order flow, quantity units, approval, rejection and reason codes.
---

# Trusted-trade ordering

The wholesaler's server checks every order against the buyer's mandate. This skill is guidance. The server is the control.

## Flow

Do the steps in order. Each step ends when its output is in hand.

1. **Read the mandate.** Call `get_mandate`. Done when you know the limits in force: spend per order (EUR, gross), allowed categories, substitution policy, payment terms. A 404 means no mandate exists. Draft one with the user (see [Mandate](#mandate)), and stop until `get_mandate` shows it.
2. **Search.** Call `search_products` with the user's need as structured fields: `terms`, `hard`, `soft`, `quantity`, `deliverBy`, `paymentTerms`, and `originalRequest` (the user's own words). Done when you hold a shortlist of candidates.
   - Put a requirement the user cannot waive in `hard`. Supported: `{ attribute: <allergen or free-from claim>, is: "free_from" }`, for example `gluten`, `egg`, `lactose`, `peanut`, and `{ attribute: "vegan", is: "yes" }`. The tool input schema lists every attribute. Any other hard constraint gives 400: tell the user that the server cannot enforce it.
   - Put a preference in `soft`. It only changes the ranking.
   - Read `match` on each candidate: `confirmed`, `contradicted` or `unknown`. Missing data is `unknown`, never `confirmed`. An `unknown` match sends the order to approval, unless the constraint is an allergen and the mandate allows missing allergen data (`allergenData.ifNoData: auto`). Vegan and the other free-from claims always go to approval when unknown.
3. **Request offers.** Call `get_offers` for the shortlist only. Done when every candidate is an offer or is listed in `omitted` with a reason.
   - Read `precheck` on each offer. It is guidance: `place_order` runs the checks again.
   - Read `claims.deliveryDate`, `claims.shortfall` and `claims.replaces`. A later date or a shortfall adds `AVAILABILITY_DIFFERS`. A substitute names the product it replaces.
4. **Choose.** Among the offers that meet the user's need, prefer one whose `precheck.decision` is `auto`. When none is `auto`, take the best offer that meets the need: the human then decides. Done when you hold one offer token per line. Keep the unchosen offers: pass them as `alternatives`.
5. **Place the order.** Call `place_order` with `offers` (tokens), optional `alternatives`, `originalRequest`, and a new `idempotencyKey`. After a timeout or a lost reply, send the same tokens with the same key: this returns the stored order and creates no second one. Done when you hold an order with a `status`.
6. **Act on the status.**

| Status                                       | Action                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `placed`                                     | Tell the user the order is placed, with delivery date and total.                                                                          |
| `pending_approval`                           | Tell the user, give `approvalUrl` and the reasons in plain words, then stop. A human decides.                                             |
| `declined`, `decision.next` = `stop`         | The human rejected the order and chose stop. Stop and tell the user. Do not look for alternatives.                                        |
| `declined`, `decision.next` = `alternatives` | The human rejected the order and allows alternatives. You may search again for the user's original need. The new order faces every check. |
| `rejected`                                   | A fixed guardrail failed. Read each code in [reason-codes.md](reason-codes.md) and take its action.                                       |
| `awaiting_payment`                           | Pay-on-order only. Call `get_order_status` later.                                                                                         |

After `pending_approval`, call `get_order_status` to read the human's decision. `list_pending_approvals` lists the orders that still wait. A pending order whose cut-off passes becomes `declined` with `next` = `alternatives`.

A request can fail before an order exists: `409 STALE_OFFER`, `400 OFFER_INVALID`, `409 CONFLICT`. See [reason-codes.md](reason-codes.md#errors-before-an-order-exists).

## Approval

Only a human approves. You have no tool that decides an approval: `decide_approval`, `register_mandate` and `revoke_mandate` are for the human's view. On a host that lists them, never call them. Send the human to `approvalUrl`. Wait for the decision.

## Mandate

Only a human registers limits. You draft them.

- To set or change the limits, or after `MANDATE_INVALID`, call `draft_mandate` with the terms the human gave: `limits`, `standingConstraints` and, if the human named one, `exp`. For a term the human did not name, keep the value of the current mandate. Without a current mandate, ask the human, or use `ask` for each policy.
- Then ask the human to check the draft and press Register in the mandate view. The draft changes nothing.
- Never say that the limits are registered or in force until `get_mandate` shows them.
- Draft new limits only when the human asks for them. Never propose higher limits on your own to get an order through.

## Units

- Money is EUR. Limits apply to the gross total: VAT and deposits included.
- State the user's quantity in standard units: `LTR` for volume, `KGM` for mass.
- The wholesaler sells in its own sales unit (for example `KI`). Every candidate gives `orderQuantity` (sales unit) and `equals` (standard units). Pass `orderQuantity` unchanged to `get_offers`: its unit is the product's sales unit and its value is a multiple of the lot size.
- A candidate with `orderQuantity: null` has no conversion. Tell the user. Do not compute one.
- Dates are `YYYY-MM-DD`.
- `paymentTerms` must equal the account's terms. The demo account uses `invoice`. Another value gives 400.
- `deliveryReliability` is a ratio from 0 to 1. `co2PerKg` is an estimate for the product group, not a measurement.

## Language

Pass `language` on every tool call that has it: the language the user writes in, as a tag such as `fi` or `en`. The view the host shows is then in the user's language. Reply to the user in the same language.

## Conduct

Never reshape an order to get around a limit. Splitting an order, lowering a quantity, moving a date, swapping a product or changing payment terms to get under a limit all count as reshaping. Refuse it even when the user asks. Tell the user the limit and let the human approve instead.

Choosing among offers that meet the user's need, before you place the order, is not reshaping. Request new offers when the decision says `alternatives` or a code in [reason-codes.md](reason-codes.md) says so. A changed order is a new request: it faces every check again.
