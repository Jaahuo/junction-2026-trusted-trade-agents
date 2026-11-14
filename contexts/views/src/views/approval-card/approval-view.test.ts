import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { OrderSchema } from "@app/contract";
import { decisionText, errorCard } from "./approval-view.ts";
import { markup } from "./template-walk.ts";

const fixtures = resolve(import.meta.dir, "../../../fixtures/approval-card");
const order = async (name: string) =>
  OrderSchema.parse(await Bun.file(resolve(fixtures, `${name}.json`)).json());

test("the error card names the approval page when there is one, else the open approvals", () => {
  const without = markup(errorCard(null, () => undefined, "The tool result does not match."));
  expect(without).not.toContain("approval page");
  expect(without).toContain("Open approvals");
  expect(without).toContain("/views/approval-card");
  expect(without).toContain("Try again in a moment.");
  expect(without).toContain("The tool result does not match.");

  const url = "https://example.test/approvals?order=ord_1";
  const withPage = markup(errorCard(url, () => undefined));
  expect(withPage).toContain("Open it on the approval page");
  expect(withPage).toContain(url);
});

test("the decision text states the outcome and the next step, without ids", async () => {
  const cases = [
    ["placed", "approved. It is placed with Valio Aimo."],
    ["awaiting-payment", "approved. It goes to Valio Aimo when the payment is confirmed."],
    ["declined-stop", "rejected. Order nothing for it"],
    ["declined-alternatives", "rejected. Look for alternatives"],
  ] as const;
  for (const [name, expected] of cases) {
    const decided = await order(name);
    const text = decisionText(decided);
    expect(text).toStartWith("Order for ");
    expect(text).toContain(expected);
    expect(text).not.toContain(decided.orderId);
  }
  const refused = { ...(await order("placed")), status: "rejected" as const };
  expect(decisionText(refused)).toContain("was not placed");
});
