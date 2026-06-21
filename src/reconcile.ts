import type {
  MpesaConfig,
  PaymentStatus,
  ReconciliationResult,
  ReconciliationMismatch,
  Logger,
  DarajaQueryResponse,
} from './types.js'
import type { StorageAdapter } from './adapters/types.js'
import { terminalQueryStatus } from './callback.js'
import { queryStkStatus, DarajaRateLimitError } from './daraja.js'

type ReconcileClassification =
  | { kind: 'status'; status: PaymentStatus }
  | { kind: 'indeterminate' }

/**
 * Classify a reconciliation query response into a definite Daraja status, or
 * `indeterminate` when the response cannot be trusted to reflect a final state.
 *
 * Reconciliation queries a transaction long after initiation, so here a
 * ResultCode of "0" means the transaction COMPLETED successfully (unlike during
 * live polling, where "0" means "still processing"). Any code that is neither
 * "0" nor a known-terminal code — e.g. the transient "4999", an unrecognised
 * code, or a non-numeric value — is `indeterminate`: we cannot prove Daraja's
 * state, so we skip rather than fabricate a terminal mismatch.
 */
function classifyQueryForReconcile(response: DarajaQueryResponse): ReconcileClassification {
  const resultCode = parseInt(response.ResultCode, 10)
  if (Number.isNaN(resultCode)) return { kind: 'indeterminate' }
  if (resultCode === 0) return { kind: 'status', status: 'SUCCESS' }
  const terminal = terminalQueryStatus(resultCode)
  if (terminal !== undefined) return { kind: 'status', status: terminal }
  return { kind: 'indeterminate' }
}

// Adaptive backoff for Daraja's Apigee SpikeArrest (HTTP 429) on the STK Query
// endpoint. We retry the SAME payment with exponential backoff + jitter rather
// than skipping it, honouring any Retry-After hint, so reconciliation
// self-throttles to whatever the real (unpublished) production limit is instead
// of relying on a hard-coded guess.
const MAX_RATE_LIMIT_RETRIES = 5
const RATE_LIMIT_BASE_DELAY_MS = 1_000
const RATE_LIMIT_MAX_DELAY_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function queryWithRateLimitBackoff(
  config: MpesaConfig,
  checkoutRequestId: string,
  timeoutMs: number,
  logger?: Logger
): Promise<DarajaQueryResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await queryStkStatus(config, checkoutRequestId, timeoutMs)
    } catch (err) {
      if (err instanceof DarajaRateLimitError && attempt < MAX_RATE_LIMIT_RETRIES) {
        const expo = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS)
        const waitMs = (err.retryAfterMs ?? expo) + Math.floor(Math.random() * 250)
        logger?.warn('Reconciliation rate-limited by Daraja — backing off', {
          checkoutRequestId,
          attempt: attempt + 1,
          waitMs,
        })
        await sleep(waitMs)
        continue
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Main reconciliation function
// ---------------------------------------------------------------------------

// All statuses are reconcilable: any stored status can diverge from Daraja's record.
// PENDING/SUCCESS are the obvious cases; FAILED/CANCELLED/TIMEOUT/EXPIRED cover the
// inverse — a payment your system wrote off that Daraja actually shows as SUCCESS
// (money moved, but you have no receipt). That is the most financially dangerous mismatch.
const RECONCILABLE_STATUSES: PaymentStatus[] = [
  'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'EXPIRED',
]

/**
 * Fetch all payments in [from, to] across all statuses, query Daraja for each,
 * and report status mismatches. Catches three classes of drift:
 *
 *   - PENDING that quietly settled — callback never arrived, poll exhausted
 *   - SUCCESS with no Daraja record — ghost credit on your side
 *   - FAILED/CANCELLED/TIMEOUT/EXPIRED that Daraja shows as SUCCESS — money moved
 *     but your system has no receipt (the most financially dangerous case)
 *
 * This function does NOT auto-correct mismatches. It returns them so the caller
 * can decide how to handle each one (notify, investigate, or bulk-update).
 *
 * Caller should handle rate-limiting: Daraja has per-second query limits.
 * If the date range contains many payments, consider batching your calls or
 * adding a delay between reconciliation runs.
 */
export async function reconcile(
  from: Date,
  to: Date,
  config: MpesaConfig,
  storage: StorageAdapter,
  logger?: Logger
): Promise<ReconciliationResult> {
  logger?.info('Starting reconciliation', { from, to })

  const allPayments = await storage.getPaymentsByStatusAndDateRange(RECONCILABLE_STATUSES, from, to)

  logger?.info('Reconciliation: payments to check', { count: allPayments.length })

  const mismatches: ReconciliationMismatch[] = []
  let checked = 0
  let matched = 0
  let skipped = 0

  const timeoutMs = config.timeoutMs ?? 75_000

  const intervalMs = config.reconcileQueryIntervalMs ?? 100

  for (const payment of allPayments) {
    try {
      const queryResult = await queryWithRateLimitBackoff(
        config,
        payment.checkoutRequestId,
        timeoutMs,
        logger
      )
      const classification = classifyQueryForReconcile(queryResult)

      if (classification.kind === 'indeterminate') {
        // Daraja returned a transient/unrecognised code (e.g. "4999") — we can't
        // prove the transaction's final state, so skip rather than report a
        // false mismatch. Re-run reconciliation later to verify it.
        skipped++
        logger?.warn('Reconciliation: indeterminate query result — skipping', {
          paymentId: payment.id,
          checkoutRequestId: payment.checkoutRequestId,
          resultCode: queryResult.ResultCode,
        })
      } else {
        const mpesaStatus = classification.status
        checked++

        if (mpesaStatus === payment.status) {
          matched++
          logger?.info('Reconciliation: payment matches', {
            paymentId: payment.id,
            status: payment.status,
          })
        } else {
          logger?.warn('Reconciliation: status mismatch found', {
            paymentId: payment.id,
            storedStatus: payment.status,
            mpesaStatus,
          })

          mismatches.push({
            paymentId: payment.id,
            checkoutRequestId: payment.checkoutRequestId,
            storedStatus: payment.status,
            mpesaStatus,
            amount: payment.amount,
          })
        }
      }
    } catch (err) {
      // Query failed even after rate-limit backoff (network error, persistent
      // 429, etc.). Log and skip — don't abort the whole reconciliation.
      // Increment skipped (not checked) so callers know this payment was NOT verified.
      skipped++
      logger?.error('Reconciliation: failed to query payment — skipping', {
        paymentId: payment.id,
        checkoutRequestId: payment.checkoutRequestId,
        error: String(err),
      })
    }

    // Politeness floor between queries. The STK Query endpoint is behind an
    // Apigee SpikeArrest policy — observed in the sandbox (June 2026) as
    // 5 requests / 60s, burst 1 (~1 req/12s). The production limit is not
    // published, so rather than hard-coding a guess we keep a small floor here
    // and let queryWithRateLimitBackoff() above self-throttle to the real limit
    // when a 429 is returned. Override via config.reconcileQueryIntervalMs.
    await sleep(intervalMs)
  }

  logger?.info('Reconciliation complete', {
    checked,
    matched,
    skipped,
    mismatches: mismatches.length,
  })

  return { checked, matched, skipped, mismatches }
}
