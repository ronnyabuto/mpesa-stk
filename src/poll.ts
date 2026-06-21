import type { MpesaConfig, PaymentStatus, PaymentRecord, Logger, DarajaQueryResponse } from './types.js'
import type { StorageAdapter } from './adapters/types.js'
import { terminalQueryStatus } from './callback.js'
import { queryStkStatus } from './daraja.js'

// ---------------------------------------------------------------------------
// Poll schedule: a Fibonacci backoff built from config.pollIntervalMs.
//
// delay(attempt) = min(pollIntervalMs * FIB[attempt], MAX_POLL_DELAY_MS)
//
// The base interval is the first wait (give Daraja/the user a moment before the
// first query); each subsequent gap grows so we don't hammer the STK Query
// endpoint while a slow customer is still entering their PIN. At the default
// 5 000 ms base this yields 5s → 10s → 15s → 25s → 30s → 30s …
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 5_000
const MAX_POLL_DELAY_MS = 30_000
const POLL_BACKOFF_MULTIPLIERS = [1, 2, 3, 5, 8, 13, 21]

function getDelay(attempt: number, pollIntervalMs: number): number {
  // attempt is 0-indexed; clamp to the last multiplier once exhausted
  const multiplier =
    POLL_BACKOFF_MULTIPLIERS[Math.min(attempt, POLL_BACKOFF_MULTIPLIERS.length - 1)] as number
  return Math.min(pollIntervalMs * multiplier, MAX_POLL_DELAY_MS)
}

// ---------------------------------------------------------------------------
// In-flight guard — prevents duplicate concurrent polls for the same ID
// ---------------------------------------------------------------------------

// Process-local: does not coordinate across multiple Node.js processes or
// serverless invocations. Concurrent polls from separate processes are safe
// because settlePayment uses an atomic CAS — only one writer wins.
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
  onSettled?: (payment: PaymentRecord) => void | Promise<void>,
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
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Wait before querying — first delay is one base interval (give Daraja
      // and the customer a moment), then a Fibonacci backoff. See getDelay.
      await sleep(getDelay(attempt, pollIntervalMs))

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
      const status = terminalQueryStatus(resultCode)

      // Only a KNOWN-TERMINAL query code settles the payment. Everything else is
      // not-yet-determinable and we keep polling:
      //   - "0"    — still processing (both ResponseCode and ResultCode are "0"
      //              and ResultDesc says "processed successfully" while the STK
      //              is still awaiting the user)
      //   - "4999" — undocumented transient code seen in the sandbox
      //   - any unrecognised code, or NaN
      // If the transaction never resolves we fall through to the maxPollAttempts
      // path below and exit as TIMEOUT, which reconciliation then double-checks.
      // This is the safe direction: a still-pending payment is never settled
      // FAILED from an ambiguous query response.
      if (status !== undefined) {
        const now = new Date()

        logger?.info('Poll found terminal status from STK Query', {
          checkoutRequestId,
          resultCode,
          status,
        })

        // Atomic CAS: only wins if callback hasn't already settled this payment
        const claimed = await storage.settlePayment(current.id, {
          status,
          failureReason: queryResult.ResultDesc,
          resultCode,
          completedAt: now,
        })

        if (!claimed) {
          logger?.info('Poll lost race to concurrent callback — returning callback status', {
            checkoutRequestId,
          })
          const current2 = await storage.getPayment(current.id)
          return current2?.status ?? status
        }

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

      // Atomic CAS: a callback may have arrived in the final sleep window
      const claimed = await storage.settlePayment(payment.id, {
        status: 'TIMEOUT',
        failureReason: 'Polling exhausted: no response from Daraja within retry window',
        completedAt: new Date(),
      })

      if (!claimed) {
        logger?.info('Poll TIMEOUT lost race to concurrent callback', { checkoutRequestId })
        const current = await storage.getPayment(payment.id)
        return current?.status ?? 'TIMEOUT'
      }

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
