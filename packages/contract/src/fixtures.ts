import type { Account } from "./account.ts";
import type { DecideApprovalInput, DecideApprovalRequest } from "./decision.ts";
import { DEMO_ACCOUNT, type DemoProducts } from "./demo.ts";
import type { ErrorEnvelope } from "./errors.ts";
import type {
  DraftMandateRequest,
  MandateDraft,
  MandateLimits,
  RegisterMandateRequest,
  StoredMandate,
} from "./mandate.ts";
import type {
  OfferClaims,
  OffersRequest,
  OffersResult,
  Precheck,
  RequoteRequest,
  ValidateRequest,
  ValidateResult,
} from "./offers.ts";
import type { Order, PendingList, PlaceOrderRequest, PrecheckRequest } from "./orders.ts";
import type { FactsRequest, FactsResult, SearchRequest, SearchResult } from "./search.ts";
import type { AvailabilityQuote, PriceQuote } from "./wholesaler.ts";

// Invented products only (team rules R-23).
const productId = "prod_test_oat_drink";
const hard: SearchRequest["hard"] = [{ attribute: "lactose", is: "free_from" }];
const soft: SearchRequest["soft"] = [{ attribute: "countryOfOrigin", prefer: "fi" }];

const account: Account = DEMO_ACCOUNT;

const searchRequest: SearchRequest = {
  terms: ["oat drink"],
  hard,
  soft,
  quantity: { value: 40, unit: "LTR" },
  deliverBy: "2026-11-20",
  paymentTerms: "invoice",
  originalRequest: "40 litres of lactose-free oat drink by Friday",
};

const searchResult: SearchResult = {
  candidates: [
    {
      productId,
      gtin: "0000000000017",
      name: "Test oat drink 1 l",
      category: "test_dairy_alternatives",
      match: { lactose: "confirmed" },
      orderQuantity: { value: 4, unit: "CT" },
      equals: { value: 48, unit: "LTR" },
      deliveryReliability: 0.97,
      co2PerKg: 0.4,
      substitutes: ["prod_test_soy_drink"],
    },
  ],
  constraints: { hard, soft },
  mandate: { id: "mnd_test_1", version: 1 },
};

const factsRequest: FactsRequest = { productIds: [productId, "prod_test_missing"], hard };

const factsResult: FactsResult = {
  products: [
    {
      productId,
      gtin: "0000000000017",
      name: "Test oat drink 1 l",
      category: "test_dairy_alternatives",
      salesUnit: "CT",
      allowedLotSize: 1,
      perSalesUnit: { value: 12, unit: "LTR" },
      countryOfOrigin: "fi",
      deliveryReliability: 0.97,
      co2PerKg: 0.4,
      match: { lactose: "confirmed" },
      substitutes: ["prod_test_soy_drink"],
    },
  ],
  unknown: ["prod_test_missing"],
};

const priceQuote: PriceQuote = {
  productId,
  unitPrice: { net: 14.4, vatRate: 14, currency: "EUR" },
  deposit: 0,
  comparisonPrice: { value: 1.2, unit: "LTR" },
  validTo: "2026-11-15T21:59:59+00:00",
};

const availabilityQuote: AvailabilityQuote = {
  productId,
  amount: 120,
  availableDate: "2026-11-19",
  nextDeliveryDate: "2026-11-20",
  cutoffAt: "2026-11-17T10:00:00+02:00",
  salesBlocked: false,
  stock: "confirmed",
};

const offersRequest: OffersRequest = {
  lines: [{ productId, quantity: { value: 4, unit: "CT" } }],
  deliverBy: "2026-11-20",
  paymentTerms: "invoice",
  hard,
  soft,
};

const offerClaims: OfferClaims = {
  iss: "http://127.0.0.1:3000",
  offerId: "off_test_1",
  customer: DEMO_ACCOUNT.customer,
  agentId: DEMO_ACCOUNT.agentId,
  productId,
  quantity: { value: 4, unit: "CT" },
  unitPrice: priceQuote.unitPrice,
  deposits: 0,
  total: { net: 57.6, gross: 65.66 },
  deliveryDate: "2026-11-19",
  requestedDate: "2026-11-20",
  nextDeliveryDate: "2026-11-20",
  stock: "confirmed",
  paymentTerms: "invoice",
  cutoffAt: "2026-11-17T10:00:00+02:00",
  replaces: null,
  shortfall: null,
  mandateId: "mnd_test_1",
  mandateVersion: 1,
  constraints: { hard, soft },
  product: {
    name: "Test oat drink 1 l",
    category: "test_dairy_alternatives",
    perSalesUnit: { value: 12, unit: "LTR" },
    countryOfOrigin: "fi",
    deliveryReliability: 0.97,
    co2PerKg: 0.4,
    match: { lactose: "confirmed" },
  },
  iat: 1_794_900_000,
  exp: 1_794_903_600,
};

const precheck: Precheck = { decision: "auto", reasons: [] };

const token = "eyJhbGciOiJFUzI1NiJ9.test-offer.signature";

const offersResult: OffersResult = {
  offers: [
    { offerId: "off_test_1", token, claims: offerClaims, precheck, rank: null, comparison: null },
  ],
  omitted: [
    { productId: "prod_test_missing", reason: "UNKNOWN_PRODUCT", detail: "Not in the catalogue." },
  ],
};

const requoteRequest: RequoteRequest = { tokens: [token] };
const validateRequest: ValidateRequest = { tokens: [token] };
const validateResult: ValidateResult = {
  results: [{ offerId: "off_test_1", ok: true }],
  products: [{ productId, liveAmount: { value: 120, unit: "CT" } }],
};

const mandateLimits: MandateLimits = {
  maxOrderTotal: { value: 1000, currency: "EUR", basis: "gross" },
  categories: null,
  substitutions: "ask",
  newProducts: "ask",
  minDeliveryReliability: { value: 0.9, ifNoData: "auto" },
  maxCo2PerKg: { value: 3, ifNoData: "auto" },
  allergenData: { ifNoData: "ask" },
  paymentTerms: { invoice: "auto", pay_on_order: "ask" },
};

const registerMandateRequest: RegisterMandateRequest = {
  operationId: "op_test_1",
  limits: mandateLimits,
  standingConstraints: { hard: [], soft },
};

const draftMandateRequest: DraftMandateRequest = {
  limits: { ...mandateLimits, maxOrderTotal: { value: 500, currency: "EUR", basis: "gross" } },
  standingConstraints: { hard: [], soft },
};

const storedMandate: StoredMandate = {
  mandate: {
    iss: DEMO_ACCOUNT.customer,
    mandateId: "mnd_test_1",
    version: 1,
    agent: DEMO_ACCOUNT.agentId,
    signedBy: DEMO_ACCOUNT.accountId,
    limits: mandateLimits,
    standingConstraints: { hard: [], soft },
    iat: 1_794_800_000,
    exp: 1_826_336_000,
  },
  jws: "eyJhbGciOiJFUzI1NiJ9.test-mandate.signature",
  status: "active",
  registeredAt: "2026-11-14T10:00:00+00:00",
};

const mandateDraft: MandateDraft = { draft: draftMandateRequest, current: storedMandate };

const placeOrderRequest: PlaceOrderRequest = {
  offers: [token],
  originalRequest: searchRequest.originalRequest,
  idempotencyKey: "idem_test_1",
};

const precheckRequest: PrecheckRequest = { offers: [token] };

const order: Order = {
  orderId: "ord_test_1",
  customer: DEMO_ACCOUNT.customer,
  agentId: DEMO_ACCOUNT.agentId,
  accountId: DEMO_ACCOUNT.accountId,
  offerIds: ["off_test_1"],
  lines: [{ offerId: "off_test_1", token, claims: offerClaims }],
  alternatives: [],
  mandateId: "mnd_test_1",
  mandateVersion: 1,
  status: "pending_approval",
  reasons: ["NEW_PRODUCT"],
  proposalVersion: 1,
  approvalUrl: "http://127.0.0.1:3000/approvals/ord_test_1",
  paymentTerms: "invoice",
  total: offerClaims.total,
  originalRequest: "40 litres of lactose-free oat drink by Friday",
  decision: null,
  requotes: [],
  nextDeliveryDate: "2026-11-20",
  audit: [
    { at: "2026-11-14T10:05:00+00:00", actor: "agent", event: "order_requested" },
    {
      at: "2026-11-14T10:05:00+00:00",
      actor: "server",
      event: "sent_to_approval",
      reason: "NEW_PRODUCT",
    },
  ],
  createdAt: "2026-11-14T10:05:00+00:00",
};

const pendingList: PendingList = { orders: [order] };

const decideApprovalRequest: DecideApprovalRequest = {
  proposalVersion: 1,
  decision: "reject",
  next: "alternatives",
  note: "Too expensive this week.",
};

const decideApprovalInput: DecideApprovalInput = {
  orderId: "ord_test_1",
  ...decideApprovalRequest,
};

const errorEnvelope: ErrorEnvelope = {
  error: { code: "STALE_OFFER", message: "Request new offers.", nextDeliveryDate: "2026-11-20" },
};

const demoProducts: DemoProducts = {
  observedAt: "2026-11-14T09:00:00+02:00",
  requestedDate: "2026-11-20",
  s1: { productId, quantity: { value: 4, unit: "CT" } },
  s2: { productId: "prod_test_milk", quantity: { value: 1000, unit: "LTR" } },
  s3: null,
  late: { productId: "prod_test_late" },
  triedForS3: [{ productId: "prod_test_cream", quantity: { value: 20, unit: "LTR" } }],
};

/** Valid examples of the contract shapes, with invented products. */
export const fixtures = {
  account,
  searchRequest,
  searchResult,
  factsRequest,
  factsResult,
  priceQuote,
  availabilityQuote,
  offersRequest,
  offerClaims,
  offersResult,
  precheck,
  requoteRequest,
  validateRequest,
  validateResult,
  mandateLimits,
  registerMandateRequest,
  storedMandate,
  draftMandateRequest,
  mandateDraft,
  placeOrderRequest,
  precheckRequest,
  order,
  pendingList,
  decideApprovalRequest,
  decideApprovalInput,
  errorEnvelope,
  demoProducts,
} as const;
