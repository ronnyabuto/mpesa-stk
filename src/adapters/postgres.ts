/**
 * PostgreSQL storage adapter using the `pg` package.
 *
 * Run this DDL once before using the adapter:
 *
 * CREATE TABLE IF NOT EXISTS mpesa_payments (
 *   id                   TEXT PRIMARY KEY,
 *   checkout_request_id  TEXT UNIQUE NOT NULL,
 *   merchant_request_id  TEXT NOT NULL,
 *   phone_number         TEXT NOT NULL,
 *   amount               INTEGER NOT NULL,
 *   account_reference    TEXT NOT NULL,
 *   status               TEXT NOT NULL DEFAULT 'PENDING'
 *                          CHECK (status IN ('PENDING','SUCCESS','FAILED','CANCELLED','TIMEOUT','EXPIRED')),
 *   mpesa_receipt_number TEXT,
 *   failure_reason       TEXT,
 *   result_code          INTEGER,
 *   initiated_at         TIMESTAMPTZ NOT NULL,
 *   completed_at         TIMESTAMPTZ,
 *   raw_callback         JSONB,
 *   idempotency_key      TEXT UNIQUE
 * );
 *
 * CREATE INDEX IF NOT EXISTS mpesa_payments_status_initiated
 *   ON mpesa_payments(status, initiated_at);
 */

import type { Pool, PoolClient } from 'pg'
import type { PaymentRecord, PaymentStatus } from '../types.js'
import type { StorageAdapter } from './types.js'

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string
  checkout_request_id: string
  merchant_request_id: string
  phone_number: string
  amount: number
  account_reference: string
  status: string
  mpesa_receipt_number: string | null
  failure_reason: string | null
  result_code: number | null
  initiated_at: Date
  completed_at: Date | null
  raw_callback: unknown | null
  idempotency_key: string | null
}

const VALID_STATUSES = new Set<string>([
  'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'EXPIRED',
])

function rowToRecord(row: PaymentRow): PaymentRecord {
  if (!VALID_STATUSES.has(row.status)) {
    throw new Error(
      `Unknown payment status "${row.status}" for payment id "${row.id}". ` +
      'This indicates a database inconsistency — check for manual edits or failed migrations.'
    )
  }

  const record: PaymentRecord = {
    id: row.id,
    checkoutRequestId: row.checkout_request_id,
    merchantRequestId: row.merchant_request_id,
    phoneNumber: row.phone_number,
    amount: row.amount,
    accountReference: row.account_reference,
    status: row.status as PaymentStatus,
    initiatedAt: row.initiated_at,
  }

  if (row.mpesa_receipt_number !== null) record.mpesaReceiptNumber = row.mpesa_receipt_number
  if (row.failure_reason !== null) record.failureReason = row.failure_reason
  if (row.result_code !== null) record.resultCode = row.result_code
  if (row.completed_at !== null) record.completedAt = row.completed_at
  if (row.raw_callback !== null) record.rawCallback = row.raw_callback

  return record
}

// ---------------------------------------------------------------------------
// PostgresAdapter
// ---------------------------------------------------------------------------

export class PostgresAdapter implements StorageAdapter {
  /**
   * @param pool - A pg.Pool instance you create and manage externally.
   *   Do not pass a PoolClient here; the adapter acquires clients internally.
   *   Shutting down the pool is your responsibility.
   */
  constructor(private readonly pool: Pool) {}

  async createPayment(record: PaymentRecord): Promise<void> {
    await this.pool.query<PaymentRow>(
      `INSERT INTO mpesa_payments (
         id, checkout_request_id, merchant_request_id,
         phone_number, amount, account_reference,
         status, mpesa_receipt_number, failure_reason, result_code,
         initiated_at, completed_at, raw_callback, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        record.id,
        record.checkoutRequestId,
        record.merchantRequestId,
        record.phoneNumber,
        record.amount,
        record.accountReference,
        record.status,
        record.mpesaReceiptNumber ?? null,
        record.failureReason ?? null,
        record.resultCode ?? null,
        record.initiatedAt,
        record.completedAt ?? null,
        record.rawCallback !== undefined ? JSON.stringify(record.rawCallback) : null,
        null, // idempotency_key set separately via registerIdempotencyKey
      ]
    )
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const result = await this.pool.query<PaymentRow>(
      'SELECT * FROM mpesa_payments WHERE id = $1 LIMIT 1',
      [id]
    )
    const row = result.rows[0]
    return row ? rowToRecord(row) : null
  }

  async getPaymentByCheckoutId(checkoutRequestId: string): Promise<PaymentRecord | null> {
    const result = await this.pool.query<PaymentRow>(
      'SELECT * FROM mpesa_payments WHERE checkout_request_id = $1 LIMIT 1',
      [checkoutRequestId]
    )
    const row = result.rows[0]
    return row ? rowToRecord(row) : null
  }

  async getPaymentByIdempotencyKey(key: string): Promise<PaymentRecord | null> {
    const result = await this.pool.query<PaymentRow>(
      'SELECT * FROM mpesa_payments WHERE idempotency_key = $1 LIMIT 1',
      [key]
    )
    const row = result.rows[0]
    return row ? rowToRecord(row) : null
  }

  async updatePayment(id: string, updates: Partial<PaymentRecord>): Promise<void> {
    // Build the SET clause dynamically from the provided updates
    const setClauses: string[] = []
    const values: unknown[] = []
    let paramIdx = 1

    const columnMap: Partial<Record<keyof PaymentRecord, string>> = {
      status: 'status',
      mpesaReceiptNumber: 'mpesa_receipt_number',
      failureReason: 'failure_reason',
      resultCode: 'result_code',
      completedAt: 'completed_at',
      rawCallback: 'raw_callback',
      merchantRequestId: 'merchant_request_id',
      phoneNumber: 'phone_number',
      amount: 'amount',
      accountReference: 'account_reference',
    }

    for (const [key, column] of Object.entries(columnMap) as [keyof PaymentRecord, string][]) {
      if (key in updates) {
        const value = updates[key]
        setClauses.push(`${column} = $${paramIdx}`)
        // Serialize rawCallback as JSON string
        if (key === 'rawCallback') {
          values.push(value !== undefined ? JSON.stringify(value) : null)
        } else {
          values.push(value !== undefined ? value : null)
        }
        paramIdx++
      }
    }

    if (setClauses.length === 0) return

    values.push(id)
    await this.pool.query(
      `UPDATE mpesa_payments SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
      values
    )
  }

  async getPaymentsByStatusAndDateRange(
    status: PaymentStatus,
    from: Date,
    to: Date
  ): Promise<PaymentRecord[]> {
    const result = await this.pool.query<PaymentRow>(
      `SELECT * FROM mpesa_payments
       WHERE status = $1 AND initiated_at >= $2 AND initiated_at <= $3
       ORDER BY initiated_at ASC`,
      [status, from, to]
    )
    return result.rows.map(rowToRecord)
  }

  /**
   * Atomically transition a PENDING payment to a terminal state.
   *
   * Uses `WHERE id = $N AND status = 'PENDING'` to ensure only one concurrent
   * callback can win the race. If rowCount === 0, the payment was already
   * settled by another request (duplicate callback) and we return false.
   *
   * This prevents double `onPaymentSettled` calls when M-Pesa fires the same
   * callback 2–4 times in rapid succession under load.
   */
  async settlePayment(id: string, updates: Partial<PaymentRecord>): Promise<boolean> {
    const setClauses: string[] = []
    const values: unknown[] = []
    let paramIdx = 1

    const columnMap: Partial<Record<keyof PaymentRecord, string>> = {
      status: 'status',
      mpesaReceiptNumber: 'mpesa_receipt_number',
      failureReason: 'failure_reason',
      resultCode: 'result_code',
      completedAt: 'completed_at',
      rawCallback: 'raw_callback',
    }

    for (const [key, column] of Object.entries(columnMap) as [keyof PaymentRecord, string][]) {
      if (key in updates) {
        const value = updates[key]
        setClauses.push(`${column} = $${paramIdx}`)
        if (key === 'rawCallback') {
          values.push(value !== undefined ? JSON.stringify(value) : null)
        } else {
          values.push(value !== undefined ? value : null)
        }
        paramIdx++
      }
    }

    if (setClauses.length === 0) return false

    values.push(id)
    const result = await this.pool.query(
      `UPDATE mpesa_payments SET ${setClauses.join(', ')} WHERE id = $${paramIdx} AND status = 'PENDING'`,
      values
    )

    return (result.rowCount ?? 0) > 0
  }

  /**
   * Attach an idempotency key to an existing payment.
   * Called by MpesaStk after a successful STK Push initiation.
   */
  async registerIdempotencyKey(key: string, paymentId: string): Promise<void> {
    await this.pool.query(
      'UPDATE mpesa_payments SET idempotency_key = $1 WHERE id = $2',
      [key, paymentId]
    )
  }

  /**
   * Run all DDL statements needed for the adapter.
   * Safe to call on every startup (uses IF NOT EXISTS).
   */
  async migrate(client?: PoolClient): Promise<void> {
    const runner = client ?? this.pool
    await runner.query(`
      CREATE TABLE IF NOT EXISTS mpesa_payments (
        id                   TEXT PRIMARY KEY,
        checkout_request_id  TEXT UNIQUE NOT NULL,
        merchant_request_id  TEXT NOT NULL,
        phone_number         TEXT NOT NULL,
        amount               INTEGER NOT NULL,
        account_reference    TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'PENDING'
                               CHECK (status IN ('PENDING','SUCCESS','FAILED','CANCELLED','TIMEOUT','EXPIRED')),
        mpesa_receipt_number TEXT,
        failure_reason       TEXT,
        result_code          INTEGER,
        initiated_at         TIMESTAMPTZ NOT NULL,
        completed_at         TIMESTAMPTZ,
        raw_callback         JSONB,
        idempotency_key      TEXT UNIQUE
      );

      CREATE INDEX IF NOT EXISTS mpesa_payments_status_initiated
        ON mpesa_payments(status, initiated_at);
    `)
  }
}
