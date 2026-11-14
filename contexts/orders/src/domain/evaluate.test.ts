import { describe, expect, test } from "bun:test";
import {
  APPROVAL_REASONS,
  type Mandate,
  type MandateLimits,
  type OfferClaims,
  type ReasonCode,
  type ValidateResult,
  fixtures,
} from "@app/contract";
import { evaluate, type HistoryRow } from "./evaluate.ts";

const now = new Date("2026-11-16T08:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

const allAuto: MandateLimits = {
  maxOrderTotal: { value: 100_000, currency: "EUR", basis: "gross" },
  categories: null,
  substitutions: "auto",
  newProducts: "auto",
  minDeliveryReliability: { value: 0.5, ifNoData: "auto" },
  maxCo2PerKg: { value: 10, ifNoData: "auto" },
  allergenData: { ifNoData: "auto" },
  paymentTerms: { invoice: "auto", pay_on_order: "auto" },
};

const mandateWith = (limits: Partial<MandateLimits> = {}): Mandate => ({
  iss: fixtures.offerClaims.customer,
  mandateId: "mnd_rules",
  version: 1,
  agent: fixtures.offerClaims.agentId,
  signedBy: "acct_rules",
  limits: { ...allAuto, ...limits },
  standingConstraints: { hard: [], soft: [] },
  iat: nowSeconds - 3600,
  exp: nowSeconds + 3600,
});

// Invented product: 4 cartons of 12 litres, confirmed stock, lactose confirmed.
const claim = (
  changes: Partial<OfferClaims> = {},
  product: Partial<OfferClaims["product"]> = {},
) => ({
  ...fixtures.offerClaims,
  cutoffAt: "2026-11-17T10:00:00+02:00",
  exp: nowSeconds + 600,
  ...changes,
  product: {
    ...fixtures.offerClaims.product,
    match: { lactose: "confirmed" as const },
    ...product,
  },
});

const usual: HistoryRow[] = [
  { productId: fixtures.offerClaims.productId, quantity: { value: 4, unit: "CT" } },
];

const run = (
  claims: OfferClaims[],
  options: { mandate?: Mandate | null; history?: HistoryRow[]; live?: ValidateResult | null } = {},
) =>
  evaluate({
    claims,
    mandate: options.mandate === undefined ? mandateWith() : options.mandate,
    history: options.history ?? usual,
    live: options.live ?? null,
    now,
  });

test("a line inside every limit is auto with no reasons", () => {
  expect(run([claim()])).toEqual({ decision: "auto", reasons: [] });
});

const approvalCases: [ReasonCode, () => ReturnType<typeof run>][] = [
  [
    "SPEND_OVER_LIMIT",
    () =>
      run([claim()], {
        mandate: mandateWith({ maxOrderTotal: { value: 50, currency: "EUR", basis: "gross" } }),
      }),
  ],
  [
    "CATEGORY_NOT_ALLOWED",
    () => run([claim()], { mandate: mandateWith({ categories: ["test_other_category"] }) }),
  ],
  [
    "SUBSTITUTION",
    () =>
      run([claim({ replaces: "prod_test_requested" })], {
        mandate: mandateWith({ substitutions: "ask" }),
      }),
  ],
  [
    "NEW_PRODUCT",
    () => run([claim()], { mandate: mandateWith({ newProducts: "ask" }), history: [] }),
  ],
  ["RELIABILITY_BELOW_MIN", () => run([claim({}, { deliveryReliability: 0.4 })])],
  ["CO2_ABOVE_MAX", () => run([claim({}, { co2PerKg: 12 })])],
  [
    "UNCONFIRMED_DATA",
    () =>
      run([claim({}, { co2PerKg: null })], {
        mandate: mandateWith({ maxCo2PerKg: { value: 10, ifNoData: "ask" } }),
      }),
  ],
  [
    "UNCONFIRMED_ALLERGEN",
    () =>
      run([claim({}, { match: { lactose: "unknown" } })], {
        mandate: mandateWith({ allergenData: { ifNoData: "ask" } }),
      }),
  ],
  [
    "UNCONFIRMED_STOCK",
    () =>
      run([claim({ stock: "unconfirmed", quantity: { value: 50, unit: "CT" } })], {
        history: [
          { productId: fixtures.offerClaims.productId, quantity: { value: 50, unit: "CT" } },
        ],
      }),
  ],
  ["QUANTITY_UNUSUAL", () => run([claim({ quantity: { value: 41, unit: "CT" } })])],
  [
    "PAYMENT_TERMS",
    () =>
      run([claim()], {
        mandate: mandateWith({ paymentTerms: { invoice: "ask", pay_on_order: "auto" } }),
      }),
  ],
  [
    "AVAILABILITY_DIFFERS",
    () => run([claim({ deliveryDate: "2026-11-21", requestedDate: "2026-11-20" })]),
  ],
];

describe("each approval reason sends the order to approval with exactly that reason", () => {
  for (const [reason, evaluateCase] of approvalCases) {
    test(reason, () => {
      expect(evaluateCase()).toEqual({ decision: "needs_approval", reasons: [reason] });
    });
  }
});

test("the cases cover every approval reason except PRICE_CHANGED, which only a re-quote produces", () => {
  const covered = new Set(approvalCases.map(([reason]) => reason));
  expect(APPROVAL_REASONS.filter((reason) => !covered.has(reason))).toEqual(["PRICE_CHANGED"]);
});

test("missing reliability data with ifNoData ask is UNCONFIRMED_DATA", () => {
  const result = run([claim({}, { deliveryReliability: null })], {
    mandate: mandateWith({ minDeliveryReliability: { value: 0.9, ifNoData: "ask" } }),
  });
  expect(result).toEqual({ decision: "needs_approval", reasons: ["UNCONFIRMED_DATA"] });
});

test("a later delivery or a shortfall is AVAILABILITY_DIFFERS", () => {
  const short = run([claim({ shortfall: { value: 12, unit: "LTR" } })]);
  expect(short.reasons).toEqual(["AVAILABILITY_DIFFERS"]);
});

test("all reasons are listed", () => {
  const result = run(
    [
      claim(
        {
          replaces: "prod_test_requested",
          deliveryDate: "2026-11-21",
          requestedDate: "2026-11-20",
        },
        { deliveryReliability: 0.4, co2PerKg: 12, category: "test_other" },
      ),
    ],
    {
      mandate: mandateWith({
        maxOrderTotal: { value: 50, currency: "EUR", basis: "gross" },
        categories: ["test_allowed"],
        substitutions: "ask",
        paymentTerms: { invoice: "ask", pay_on_order: "ask" },
      }),
    },
  );
  expect(result.decision).toBe("needs_approval");
  const expected: ReasonCode[] = [
    "AVAILABILITY_DIFFERS",
    "CATEGORY_NOT_ALLOWED",
    "CO2_ABOVE_MAX",
    "PAYMENT_TERMS",
    "RELIABILITY_BELOW_MIN",
    "SPEND_OVER_LIMIT",
    "SUBSTITUTION",
  ];
  expect(result.reasons.toSorted()).toEqual(expected.toSorted());
});

test("UNCONFIRMED_STOCK and QUANTITY_UNUSUAL stay with an all-auto mandate", () => {
  const result = run([claim({ stock: "unconfirmed", quantity: { value: 50, unit: "CT" } })]);
  expect(result).toEqual({
    decision: "needs_approval",
    reasons: ["QUANTITY_UNUSUAL", "UNCONFIRMED_STOCK"],
  });
});

test("quantity rules apply to the sum of the lines of one product", () => {
  const half = claim({ quantity: { value: 21, unit: "CT" } });
  expect(run([half]).reasons).toEqual([]);
  expect(run([half, { ...half, offerId: "off_test_2" }]).reasons).toEqual(["QUANTITY_UNUSUAL"]);
});

test("with no history the cap is 2000 std units, and no conversion counts as over", () => {
  const ok = claim({ quantity: { value: 166, unit: "CT" } });
  expect(run([ok], { history: [] }).reasons).toEqual([]);
  expect(run([claim({ quantity: { value: 167, unit: "CT" } })], { history: [] }).reasons).toEqual([
    "QUANTITY_UNUSUAL",
  ]);
  expect(run([claim({}, { perSalesUnit: null })], { history: [] }).reasons).toEqual([
    "QUANTITY_UNUSUAL",
  ]);
});

test("a unit size that is not a positive number counts as no conversion", () => {
  for (const value of [0, -12, Number.NaN]) {
    const odd = claim({}, { perSalesUnit: { value, unit: "LTR" } });
    expect(run([odd], { history: [] }).reasons).toEqual(["QUANTITY_UNUSUAL"]);
    expect(run([{ ...odd, stock: "unconfirmed" }], { history: [] }).reasons).toEqual([
      "QUANTITY_UNUSUAL",
      "UNCONFIRMED_STOCK",
    ]);
  }
});

test("lines of one product in different units count as over every quantity cap", () => {
  const cartons = claim({ quantity: { value: 4, unit: "CT" } });
  const litres = { ...cartons, offerId: "off_test_2", quantity: { value: 4, unit: "LTR" } };
  expect(run([cartons, litres]).reasons).toEqual(["QUANTITY_UNUSUAL"]);
  expect(run([cartons, litres], { history: [] }).reasons).toEqual(["QUANTITY_UNUSUAL"]);
  expect(
    run(
      [
        { ...cartons, stock: "unconfirmed" },
        { ...litres, stock: "unconfirmed" },
      ],
      {
        history: [],
      },
    ).reasons,
  ).toEqual(["QUANTITY_UNUSUAL", "UNCONFIRMED_STOCK"]);
});

test("history in std units is compared after conversion to sales units", () => {
  const litres: HistoryRow[] = [
    { productId: fixtures.offerClaims.productId, quantity: { value: 48, unit: "LTR" } },
  ];
  expect(
    run([claim({ quantity: { value: 40, unit: "CT" } })], { history: litres }).reasons,
  ).toEqual([]);
  expect(
    run([claim({ quantity: { value: 41, unit: "CT" } })], { history: litres }).reasons,
  ).toEqual(["QUANTITY_UNUSUAL"]);
});

describe("hard constraints", () => {
  test("an unknown allergen match is placed automatically only when allergenData is auto", () => {
    const unknown = claim({}, { match: { lactose: "unknown" } });
    expect(run([unknown]).decision).toBe("auto");
    expect(
      run([unknown], { mandate: mandateWith({ allergenData: { ifNoData: "ask" } }) }).reasons,
    ).toEqual(["UNCONFIRMED_ALLERGEN"]);
  });

  test("a contradicted or missing match goes to approval whatever the setting", () => {
    expect(run([claim({}, { match: { lactose: "contradicted" } })]).reasons).toEqual([
      "UNCONFIRMED_ALLERGEN",
    ]);
    expect(run([claim({}, { match: {} })]).reasons).toEqual(["UNCONFIRMED_ALLERGEN"]);
  });
});

describe("rejections", () => {
  test("no mandate rejects with MANDATE_INVALID", () => {
    expect(run([claim()], { mandate: null })).toEqual({
      decision: "rejected",
      reasons: ["MANDATE_INVALID"],
    });
  });

  test("a passed cut-off rejects with CUTOFF_PASSED and takes precedence over expiry", () => {
    const late = claim({ cutoffAt: "2026-11-16T07:59:59Z", exp: nowSeconds - 1 });
    expect(run([late])).toEqual({ decision: "rejected", reasons: ["CUTOFF_PASSED"] });
  });

  test("an offer at or past exp rejects with OFFER_EXPIRED", () => {
    expect(run([claim({ exp: nowSeconds })])).toEqual({
      decision: "rejected",
      reasons: ["OFFER_EXPIRED"],
    });
  });

  test("a reject reason wins over approval reasons, which are still listed", () => {
    const result = run([claim({ exp: nowSeconds - 1 })], {
      mandate: mandateWith({ maxOrderTotal: { value: 50, currency: "EUR", basis: "gross" } }),
    });
    expect(result).toEqual({
      decision: "rejected",
      reasons: ["OFFER_EXPIRED", "SPEND_OVER_LIMIT"],
    });
  });

  test("validate results reject a sales block or a lost date", () => {
    const live: ValidateResult = {
      results: [
        {
          offerId: fixtures.offerClaims.offerId,
          ok: false,
          reason: "SALES_BLOCKED",
          nextDeliveryDate: null,
        },
      ],
      products: [],
    };
    expect(run([claim()], { live }).reasons).toEqual(["SALES_BLOCKED"]);
    const lost: ValidateResult = {
      results: [
        {
          offerId: fixtures.offerClaims.offerId,
          ok: false,
          reason: "NO_DELIVERY_DATE",
          nextDeliveryDate: null,
        },
      ],
      products: [],
    };
    expect(run([claim()], { live: lost }).reasons).toEqual(["CUTOFF_PASSED"]);
  });
});
