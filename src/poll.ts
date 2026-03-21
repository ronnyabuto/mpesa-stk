import type { MpesaConfig, PaymentStatus, Logger, DarajaQueryResponse } from './types.js'
import type { StorageAdapter } from './adapters/types.js'
import { resultCodeToStatus } from './callback.js'
import { queryStkStatus } from './daraja.js'

// ---------------------------------------------------------------------------
// Fibonacci-ish poll schedule (ms), capped at 30 000
// ---------------------------------------------------------------------------

const POLL_DELAYS_MS = [3000, 5000, 8000, 13000, 21000, 34000].map((d) =>
  Math.min(d, 30000)
)

function getDelay(attempt: number): number {
  // attempt is 0-indexed
  if (attempt < POLL_DELAYS_MS.length) {
    return POLL_DELAYS_MS[attempt] as number
  }
  return 30000
}

// ---------------------------------------------------------------------------
// In-flight guard — prevents duplicate concurrent polls for the same ID
// ---------------------------------------------------------------------------

const activePollIds = new Set<string>()

// ---------------------------------------------------------------------------
// sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

export async function pollPaymentStatus(
  checkoutRequestId: string,
  config: MpesaConfig,
  storage: StorageAdapter,
  onSettled?: (payment: import('./types.js').PaymentRecord) => void | Promise<void>,
  logger?: Logger
): Promise<PaymentStatus> {
  // Check storage before acquiring the lock — callback may have already arrived
  const initial = await storage.getPaymentByCheckoutId(checkoutRequestId)
  if (!initial) {
    throw new Error(`No payment found for CheckoutRequestID "${checkoutRequestId}"`)
  }

  if (initial.status !== 'PENDING') {
    logger?.info('Poll skipped — payment already settled', {
      checkoutRequestId,
      status: initial.status,
    })
    return initial.status
  }

  // Duplicate-poll guard
  if (activePollIds.has(checkoutRequestId)) {
    logger?.warn('Poll already in progress for this checkoutRequestId — returning immediately', {
      checkoutRequestId,
    })
    return initial.status
  }

  activePollIds.add(checkoutRequestId)
  const maxAttempts = config.maxPollAttempts ?? 10

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Wait before querying (first delay is 3s — give Daraja a moment)
      await sleep(getDelay(attempt))

      // Re-check storage — callback might have arrived while we were sleeping
      const current = await storage.getPaymentByCheckoutId(checkoutRequestId)
      if (!current) break

      if (current.status !== 'PENDING') {
        logger?.info('Poll ending — callback arrived during sleep', {
          checkoutRequestId,
          status: current.status,
          attempt,
        })
        return current.status
      }

      logger?.info('Polling STK status', { checkoutRequestId, attempt })

      let queryResult: DarajaQueryResponse
      try {
        queryResult = await queryStkStatus(config, checkoutRequestId, config.timeoutMs ?? 75_000)
      } catch (err) {
        logger?.warn('STK Query network error — will retry', {
          checkoutRequestId,
          attempt,
          error: String(err),
        })
        continue
      }

      const resultCode = parseInt(queryResult.ResultCode, 10)

      // ResultCode "0" from the query means Daraja accepted the query request,
      // but ResponseCode "0" + a still-pending state means the STK is still processing.
      // We treat any non-zero ResultCode as a terminal state.
      //
      // Daraja quirk: during processing, both ResponseCode and ResultCode are "0"
      // and ResultDesc says "The service request is processed successfully."
      // In that ambiguous case we continue polling.
      if (resultCode !== 0) {
        const status = resultCodeToStatus(resultCode)
        const now = new Date()

        logger?.info('Poll found terminal status from STK Query', {
          checkoutRequestId,
          resultCode,
          status,
        })

        await storage.updatePayment(current.id, {
          status,
          failureReason: queryResult.ResultDesc,
          resultCode,
          completedAt: now,
        })

        const updated = await storage.getPayment(current.id)
        if (updated && onSettled) {
          try {
            await onSettled(updated)
          } catch (err) {
            logger?.error('onPaymentSettled handler threw', { error: String(err) })
          }
        }
        return status
      }

      // Still processing — keep looping
    }

    // Exhausted all attempts — mark as TIMEOUT
    const payment = await storage.getPaymentByCheckoutId(checkoutRequestId)
    if (payment && payment.status === 'PENDING') {
      logger?.warn('Poll exhausted maxPollAttempts — marking as TIMEOUT', {
        checkoutRequestId,
        maxAttempts,
      })
      await storage.updatePayment(payment.id, {
        status: 'TIMEOUT',
        failureReason: 'Polling exhausted: no response from Daraja within retry window',
        completedAt: new Date(),
      })

      const updated = await storage.getPayment(payment.id)
      if (updated && onSettled) {
        try {
          await onSettled(updated)
        } catch (err) {
          logger?.error('onPaymentSettled handler threw', { error: String(err) })
        }
      }
      return 'TIMEOUT'
    }

    // Payment was settled by another path while we were polling
    const final = await storage.getPaymentByCheckoutId(checkoutRequestId)
    return final?.status ?? 'PENDING'
  } finally {
    activePollIds.delete(checkoutRequestId)
  }
}
