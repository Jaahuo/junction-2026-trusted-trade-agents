import type { AuditEvent, Mandate, OfferClaims, Order } from "@app/contract";
import type { Result } from "@app/kernel";
import type { HistoryRow } from "../domain/evaluate.ts";

/** An order as stored: the approval URL is computed on read (SPEC-010). */
export type StoredOrder = Omit<Order, "approvalUrl"> & {
  idempotencyKey: string;
  requested: { offers: string[]; alternatives: string[] };
};

type VerifiedOffer = Result<
  OfferClaims,
  { code: "OFFER_INVALID" } | { code: "OFFER_EXPIRED"; claims: OfferClaims }
>;

/** Verifies an offer token's signature, alg, typ and kid; an expired offer comes back with its claims. */
export type OfferVerifier = (token: string, now: Date) => Promise<VerifiedOffer>;

export interface MandatePort {
  /** The current mandate of the principal's agent; null when there is none. */
  current(): Promise<Result<Mandate | null, "UPSTREAM_FAILED">>;
}

export interface PaymentPort {
  /** The pay-on-order step of placement. */
  authorize(order: StoredOrder): Promise<Result<void, "PAYMENT_FAILED">>;
}

/** Work inside one transaction that holds the customer's placement lock. */
export interface OrderTx {
  findByKey(customer: string, idempotencyKey: string): Promise<StoredOrder | null>;
  insert(order: StoredOrder): Promise<void>;
  update(order: StoredOrder): Promise<void>;
  /** Gross total of the customer's placed invoice orders, EUR. */
  placedInvoiceGross(customer: string): Promise<number>;
  addHistory(customer: string, rows: HistoryRow[], placedAt: Date): Promise<void>;
}

export interface OrderStore {
  find(customer: string, orderId: string): Promise<StoredOrder | null>;
  findByKey(customer: string, idempotencyKey: string): Promise<StoredOrder | null>;
  history(customer: string, productIds: string[]): Promise<HistoryRow[]>;
  refuse(customer: string, event: AuditEvent): Promise<void>;
  /** Runs `work` in one transaction, serialised per customer. */
  withCustomerLock<T>(customer: string, work: (tx: OrderTx) => Promise<T>): Promise<T>;
}
