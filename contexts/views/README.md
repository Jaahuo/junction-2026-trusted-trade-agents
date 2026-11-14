# Views

The MCP App views are Lit web components in `src/views/<view>/`.
Each view reads one tool result and shows it in the chat or on its plain page.
Read [DESIGN.md](../../DESIGN.md#views-and-another-wholesaler) before you change a view's look.

## Add view coverage with a fixture

To cover a new state of a view, add a fixture, not a new render test:

1. Save the tool result as `fixtures/<view>/<state>.json`. Name an error result `error*` and an empty list `*empty*`.
2. Run `bun test contexts/views`.

`src/shared/render-fixtures.test.ts` renders every view with every fixture in `fixtures/`.
It fails when the view shows `undefined`, `NaN` or `[object Object]`, or shows the same sentence twice in one list row or twice outside the lists.
It also fails when an approval card for a pending order has no approve or reject button, or when the approval list has no review button for each order.
`src/shared/fixtures.test.ts` checks that each fixture gives the state its name says.
The harness at `/views/harness?view=<view>` shows every fixture in a browser.

Write a separate test only for behavior a fixture cannot show, such as a click that sends a request.
`src/views/approval-card/template-walk.ts` finds a rendered button's click handler without a DOM.
