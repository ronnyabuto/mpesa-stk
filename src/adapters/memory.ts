import type { PaymentRecord, PaymentStatus } from '../types.js'
import type { StorageAdapter } from './types.js'

/**
 * In-memory storage adapter.
 *
 * Suitable for unit tests and local demos ONLY — all state is lost on
 * process restart. Do not use in production.
 */
export class MemoryAdapter implements StorageAdapter {
  // Primary store keyed by internal payment ID
  private readonly payments = new Map<string, PaymentRecord>()

  // Secondary index: checkoutRequestId → paymentId
  private readonly byCheckoutId = new Map<string, string>()

  // Secondary index: idempotencyKey → paymentId
  private readonly byIdempotencyKey = new Map<string, string>()

  async createPayment(record: PaymentRecord): Promise<void> {
    if (this.payments.has(record.id)) {
      throw new Error(`Payment with id "${record.id}" already exists`)
    }
    // Deep-clone so external mutations don't affect stored state
    this.payments.set(record.id, structuredClone(record))
    this.byCheckoutId.set(record.checkoutRequestId, record.id)
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const record = this.payments.get(id)
    return record ? structuredClone(record) : null
  }

  async getPaymentByCheckoutId(checkoutRequestId: string): Promise<PaymentRecord | null> {
    const id = this.byCheckoutId.get(checkoutRequestId)
    if (!id) return null
    return this.getPayment(id)
  }

  async getPaymentByIdempotencyKey(key: string): Promise<PaymentRecord | null> {
    const id = this.byIdempotencyKey.get(key)
    if (!id) return null
    return this.getPayment(id)
  }

  async updatePayment(id: string, updates: Partial<PaymentRecord>): Promise<void> {
    const existing = this.payments.get(id)
    if (!existing) {
      throw new Error(`Payment with id "${id}" not found`)
    }

    // Merge updates — preserving original phoneNumber unless explicitly overridden
    const updated: PaymentRecord = { ...existing, ...updates }
    this.payments.set(id, updated)

    // If checkoutRequestId changed (shouldn't happen, but be safe)
    if (updates.checkoutRequestId && updates.checkoutRequestId !== existing.checkoutRequestId) {
      this.byCheckoutId.delete(existing.checkoutRequestId)
      this.byCheckoutId.set(updates.checkoutRequestId, id)
    }
  }

  /**
   * Atomically transition a PENDING payment to a terminal state.
   * Returns true if the update was applied, false if the payment was already
   * in a non-PENDING state (duplicate callback race condition).
   *
   * NOTE: JavaScript is single-threaded within a process, so this Map
   * operation is effectively atomic for in-process concurrent callbacks.
   * It does NOT protect against duplicate callbacks across separate processes
   * or serverless invocations — use PostgresAdapter in production.
   */
  async settlePayment(id: string, updates: Partial<PaymentRecord>): Promise<boolean> {
    const existing = this.payments.get(id)
    if (!existing) {
      throw new Error(`Payment with id "${id}" not found`)
    }
    // If already settled, this is a duplicate — do not overwrite
    if (existing.status !== 'PENDING') {
      return false
    }
    const updated: PaymentRecord = { ...existing, ...updates }
    this.payments.set(id, updated)
    return true
  }

  async getPaymentsByStatusAndDateRange(
    status: PaymentStatus,
    from: Date,
    to: Date
  ): Promise<PaymentRecord[]> {
    const results: PaymentRecord[] = []
    for (const record of this.payments.values()) {
      if (
        record.status === status &&
        record.initiatedAt >= from &&
        record.initiatedAt <= to
      ) {
        results.push(structuredClone(record))
      }
    }
    return results
  }

  /**
   * Register an idempotency key → paymentId mapping.
   * Called internally by the client after createPayment succeeds.
   */
  async registerIdempotencyKey(key: string, paymentId: string): Promise<void> {
    this.byIdempotencyKey.set(key, paymentId)
  }

  /** Test helper: return the total number of stored payments */
  get size(): number {
    return this.payments.size
  }

  /** Test helper: clear all state */
  clear(): void {
    this.payments.clear()
    this.byCheckoutId.clear()
    this.byIdempotencyKey.clear()
  }
}
