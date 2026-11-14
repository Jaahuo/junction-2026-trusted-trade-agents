# Reason codes

The list is fixed. Read the code, not the free text. Codes appear in `precheck.reasons` on an offer and in `reasons` on an order. An order lists every reason that fired.

Results:

- **Approval**: a human decides.
  - In a `precheck`, an approval code means the order will go to a human. Place it when the offer meets the user's need. Then follow the order-result action.
  - In an order with status `pending_approval`, take the action in the table: tell the user, give `approvalUrl`, and stop.
- **Rejected**: the order is `rejected` and final. Take the action in the table. A new request is a new order with a new `idempotencyKey`.
- **Refused**: the request fails with an error and no order is stored.

## Approval codes

| Code                    | Meaning                                                                           | Next action (order is `pending_approval`)                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SPEND_OVER_LIMIT`      | The order gross total is above the mandate's spend limit.                         | Tell the user the total and the limit. Stop. Do not split or shrink the order.                                                  |
| `CATEGORY_NOT_ALLOWED`  | The product category is not allowed by the mandate.                               | Tell the user. Stop.                                                                                                            |
| `SUBSTITUTION`          | The order holds a substitute for the requested product.                           | Tell the user which product replaces which, with the price, origin and reliability differences. Stop.                           |
| `NEW_PRODUCT`           | The customer has not ordered this product before.                                 | Tell the user. Stop.                                                                                                            |
| `RELIABILITY_BELOW_MIN` | The product's delivery reliability is below the mandate's minimum.                | Tell the user the score and the minimum. Stop.                                                                                  |
| `CO2_ABOVE_MAX`         | The product's estimated CO2 per kg is above the mandate's maximum.                | Tell the user the estimate and the maximum. Stop.                                                                               |
| `UNCONFIRMED_DATA`      | Reliability or CO2 data is missing, and the mandate says ask.                     | Tell the user which data is missing. Stop.                                                                                      |
| `UNCONFIRMED_ALLERGEN`  | A required allergen property (for example lactose free) is not confirmed.         | Tell the user which property is unconfirmed. Stop.                                                                              |
| `UNCONFIRMED_STOCK`     | The supplier does not confirm stock, and the product total is over 500 std units. | Tell the user. Stop. No mandate setting turns this into `auto`.                                                                 |
| `QUANTITY_UNUSUAL`      | The quantity is far above the product's usual orders.                             | Check the quantity against the user's request. Tell the user. Stop. No mandate setting turns this into `auto`.                  |
| `PAYMENT_TERMS`         | The mandate asks for approval of these payment terms.                             | Tell the user. Stop.                                                                                                            |
| `PRICE_CHANGED`         | The price changed since the offer was made. It appears after a re-quote.          | Tell the user the order is still pending and the approver sees the old and new price. Stop.                                     |
| `AVAILABILITY_DIFFERS`  | The delivery is later than requested, or the amount is smaller than requested.    | Before you place the order, you may compare an offer that arrives on time. If you place the late offer, tell the user and stop. |

## Rejected codes

| Code                | Meaning                                                                                                | Next action                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_AUTHENTICATED` | The request was not authenticated. The first build never returns it.                                   | Tell the user. Stop.                                                                                                             |
| `MANDATE_INVALID`   | No valid mandate exists for the agent: none, expired or revoked.                                       | Tell the user. Call `draft_mandate` with the terms the user gives, and ask the user to press Register in the mandate view. Stop. |
| `OFFER_INVALID`     | An offer token failed verification, or the request repeats a token. Refused with 400, no order stored. | Call `quote_offers` again. Place the new tokens unchanged, each token once.                                                      |
| `OFFER_EXPIRED`     | An offer expired before the order was placed.                                                          | Call `quote_offers` again for the same need. Place the new tokens with a new `idempotencyKey`.                                   |
| `CREDIT_LIMIT`      | The order total is above the remaining credit.                                                         | Tell the user the total and the remaining credit. Stop. Do not shrink or split the order to fit.                                 |
| `PAYMENT_FAILED`    | The payment was not authorized.                                                                        | Tell the user. Stop.                                                                                                             |
| `CUTOFF_PASSED`     | The order cut-off for the delivery date has passed.                                                    | Tell the user the next delivery date from `nextDeliveryDate`. Request new offers for that date only when the user accepts it.    |
| `SALES_BLOCKED`     | The product is blocked from sale.                                                                      | Tell the user. You may search again for the user's need and place a new order for a product that is not blocked.                 |

## Errors before an order exists

These are error codes, not reason codes. No order is stored.

| Error                 | Meaning                                                                                       | Next action                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `409 STALE_OFFER`     | The mandate changed since the offers were made, or live stock is below the order quantity.    | Call `quote_offers` again. Place the new tokens.                                                                                |
| `400 OFFER_INVALID`   | See `OFFER_INVALID` above.                                                                    | See `OFFER_INVALID` above.                                                                                                      |
| `409 CONFLICT`        | The `idempotencyKey` was used with other tokens.                                              | Send the original tokens again with the same key to read the stored order. Use a new key only for a new request the user wants. |
| `400 BAD_REQUEST`     | The input is invalid, or holds a field the server refuses, or an unsupported hard constraint. | Read the message. Fix the input. Do not retry unchanged.                                                                        |
| `502 UPSTREAM_FAILED` | The wholesaler's systems did not answer.                                                      | Tell the user. Retry later.                                                                                                     |
