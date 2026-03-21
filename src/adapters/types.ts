import type { PaymentRecord, PaymentStatus } from '../types.js'

export interface StorageAdapter {
  /** Create a new payment record in PENDING state */
  createPayment(record: PaymentRecord): Promise<void>

  /** Find by your internal ID */
  getPayment(id: string): Promise<PaymentRecord | null>

  /** Find by M-Pesa's CheckoutRequestID */
  getPaymentByCheckoutId(checkoutRequestId: string): Promise<PaymentRecord | null>

  /**
   * Find by idempotency key.
   * Implementations must store the mapping idempotencyKey → paymentId separately
   * (or as a column) so this lookup is O(1).
   */
  getPaymentByIdempotencyKey(key: string): Promise<PaymentRecord | null>

  /** Update status and/or any other fields on a payment */
  updatePayment(id: string, updates: Partial<PaymentRecord>): Promise<void>

  /**
   * Atomically transition a payment from PENDING to a terminal status.
   *
   * Returns `true` if the update succeeded (the payment was PENDING and is now
   * updated), or `false` if the payment was already in a non-PENDING state
   * (duplicate callback/race condition).
   *
   * Implementations MUST make this transition atomic (compare-and-swap) to
   * prevent double-processing when M-Pesa fires the same callback twice within
   * milliseconds. This is the primary deduplication guard.
   */
  settlePayment(
    id: string,
    updates: Partial<PaymentRecord>
  ): Promise<boolean>

  /**
   * Attach an idempotency key to an existing payment record.
   * Called by MpesaStk after a successful STK Push initiation.
   * Implementations that store the key at creation time may make this a no-op.
   */
  registerIdempotencyKey(key: string, paymentId: string): Promise<void>

  /**
   * For reconciliation: get all payments in a given status within a date range.
   * `from` and `to` are compared against `initiatedAt`.
   */
  getPaymentsByStatusAndDateRange(
    status: PaymentStatus,
    from: Date,
    to: Date
  ): Promise<PaymentRecord[]>
}
