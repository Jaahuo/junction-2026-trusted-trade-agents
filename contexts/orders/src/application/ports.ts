import type {
  AuditEvent,
  Mandate,
  OfferClaims,
  OffersResult,
  Order,
  RequoteRequest,
  SubstitutePair,
} from "@app/contract";
import type { Result } from "@app/kernel";
import type { HistoryRow } from "../domain/evaluate.ts";

/** An order as stored: the approval URL is computed on read (SPEC-010). */
export type StoredOrder = Omit<Order, "approvalUrl"> & {
  idempotencyKey: string;
  requested: {
    offers: string[];
    alternatives: string[];
    supersedes?: { orderId: string; proposalVersion: number };
  };
};

type VerifiedOffer = Result<
  OfferClaims,
  { code: "OFFER_INVALID" } | { code: "OFFER_EXPIRED"; claims: OfferClaims }
>;

/** Verifies an offer token's signature, alg, typ and kid; an expired offer comes back with its claims. */
export type OfferVerifier = (token: string, now: Date) => Promise<VerifiedOffer>;

export interface MandatePort {
  /** The current mandate of the agent; null when the agent has none. */
  current(agentId: string): Promise<Result<Mandate | null, "UPSTREAM_FAILED">>;
}

export interface RequotePort {
  /** New signed offers for the tokens with the changes applied (SPEC-006 `requote`). */
  requote(
    request: RequoteRequest,
  ): Promise<Result<OffersResult, "BAD_REQUEST" | "UPSTREAM_FAILED">>;
}

export interface PaymentPort {
  /** The pay-on-order step of placement. */
  authorize(order: StoredOrder): Promise<Result<void, "PAYMENT_FAILED">>;
}
export type ReceiptSigner = (order: StoredOrder) => Promise<Result<string, "UPSTREAM_FAILED">>;

/** Work inside one transaction that holds the customer's placement lock. */
export interface OrderTx {
  find(customer: string, orderId: string): Promise<StoredOrder | null>;
  findByKey(customer: string, idempotencyKey: string): Promise<StoredOrder | null>;
  hasUsedOffers(customer: string, offerIds: readonly string[]): Promise<boolean>;
  /** The customer's approved orders with a line that is this substitute pair. */
  approvedWithPair(customer: string, pair: SubstitutePair): Promise<StoredOrder[]>;
  insert(order: StoredOrder): Promise<void>;
  /**
   * Writes the next state of a pending order (a decision, or the approver's next proposal) over the
   * one read at `proposalVersion`. False when the stored order is no longer pending at
   * `proposalVersion`, so only one write wins.
   */
  decide(order: StoredOrder, proposalVersion: number): Promise<boolean>;
  /** Gross total of the customer's placed invoice orders, EUR. */
  placedInvoiceGross(customer: string): Promise<number>;
  addHistory(customer: string, rows: HistoryRow[], placedAt: Date): Promise<void>;
}

export interface OrderStore {
  find(customer: string, orderId: string): Promise<StoredOrder | null>;
  /** The customer's orders that wait for a decision, oldest first. */
  pending(customer: string): Promise<StoredOrder[]>;
  /** Pending orders with at least one line at or past its cutoff, optionally for one customer. */
  expiredPending(now: Date, customer?: string): Promise<StoredOrder[]>;
  findByKey(customer: string, idempotencyKey: string): Promise<StoredOrder | null>;
  history(customer: string, productIds: string[]): Promise<HistoryRow[]>;
  refuse(customer: string, event: AuditEvent): Promise<Result<void, "AUDIT_INVALID">>;
  /** Runs `work` in one transaction, serialised per customer. */
  withCustomerLock<T>(customer: string, work: (tx: OrderTx) => Promise<T>): Promise<T>;
}
