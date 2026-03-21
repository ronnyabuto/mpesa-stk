import type {
  MpesaConfig,
  PaymentStatus,
  ReconciliationResult,
  ReconciliationMismatch,
  Logger,
  DarajaQueryResponse,
} from './types.js'
import type { StorageAdapter } from './adapters/types.js'
import { resultCodeToStatus } from './callback.js'
import { queryStkStatus } from './daraja.js'

function queryStatusToPaymentStatus(response: DarajaQueryResponse): PaymentStatus {
  const resultCode = parseInt(response.ResultCode, 10)
  if (isNaN(resultCode)) return 'FAILED'

  // ResultCode 0 from the query API means the transaction was processed successfully
  if (resultCode === 0) return 'SUCCESS'
  return resultCodeToStatus(resultCode)
}

// ---------------------------------------------------------------------------
// Main reconciliation function
// ---------------------------------------------------------------------------

/**
 * Fetch all PENDING and SUCCESS payments in [from, to], query Daraja for each,
 * and report status mismatches.
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

  // Collect payments we want to verify: PENDING (might have been paid) and SUCCESS (might be ghost)
  const [pendingPayments, successPayments] = await Promise.all([
    storage.getPaymentsByStatusAndDateRange('PENDING', from, to),
    storage.getPaymentsByStatusAndDateRange('SUCCESS', from, to),
  ])

  const allPayments = [...pendingPayments, ...successPayments]

  logger?.info('Reconciliation: payments to check', { count: allPayments.length })

  const mismatches: ReconciliationMismatch[] = []
  let checked = 0
  let matched = 0
  let skipped = 0

  const timeoutMs = config.timeoutMs ?? 75_000

  for (const payment of allPayments) {
    try {
      const queryResult = await queryStkStatus(config, payment.checkoutRequestId, timeoutMs)
      const mpesaStatus = queryStatusToPaymentStatus(queryResult)

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
    } catch (err) {
      // If Daraja query fails for one payment, log and skip — don't abort the whole reconciliation.
      // Increment skipped (not checked) so callers know this payment was NOT verified.
      skipped++
      logger?.error('Reconciliation: failed to query payment — skipping', {
        paymentId: payment.id,
        checkoutRequestId: payment.checkoutRequestId,
        error: String(err),
      })
    }

    // 100 ms between queries keeps us below Daraja's per-second rate limit (~15 req/s production)
    await new Promise<void>((r) => setTimeout(r, 100))
  }

  logger?.info('Reconciliation complete', {
    checked,
    matched,
    skipped,
    mismatches: mismatches.length,
  })

  return { checked, matched, skipped, mismatches }
}
