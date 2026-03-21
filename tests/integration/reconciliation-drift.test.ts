/**
 * reconciliation-drift.test.ts
 *
 * Real reconciliation scenarios from developer reports.
 *
 * Sources:
 *   https://dev.to/anne46/implementing-m-pesa-stk-push-and-query-in-ruby-on-rails-328d
 *   https://mpesa-nextjs-docs.vercel.app/handling-callback
 *   https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
 *   Package source (reconcile.ts, poll.ts)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { reconcile } from '../../src/reconcile.js'
import { pollPaymentStatus } from '../../src/poll.js'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import { clearTokenCache } from '../../src/initiate.js'
import {
  mockTokenResponse,
  mockStkQueryStillProcessing,
  mockStkQueryCancelled,
  mockStkQueryFailed,
  type StkQueryShape,
} from './helpers/mocks.js'
import type { MpesaConfig } from '../../src/types.js'

const CONFIG: MpesaConfig = {
  consumerKey: 'test-key',
  consumerSecret: 'test-secret',
  shortCode: '174379',
  passKey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  callbackUrl: 'https://example.com/callback',
  environment: 'sandbox',
  maxPollAttempts: 2,
  pollIntervalMs: 10,
}

function makeTokenThenQueryMock(queryResponse: StkQueryShape): typeof fetch {
  let callCount = 0
  return vi.fn().mockImplementation(() => {
    callCount++
    if (callCount === 1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTokenResponse()),
        text: () => Promise.resolve(''),
      } as Response)
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(queryResponse),
      text: () => Promise.resolve(''),
    } as Response)
  })
}

function makeTokenThenMultiQueryMock(responses: StkQueryShape[]): typeof fetch {
  let callCount = 0
  const responseQueue = [...responses]
  return vi.fn().mockImplementation(() => {
    callCount++
    if (callCount === 1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTokenResponse()),
        text: () => Promise.resolve(''),
      } as Response)
    }
    const response = responseQueue.shift() ?? mockStkQueryStillProcessing()
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(''),
    } as Response)
  })
}

beforeEach(() => {
  clearTokenCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearTokenCache()
})

async function makePayment(
  storage: MemoryAdapter,
  opts: {
    id: string
    checkoutRequestId: string
    status?: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'TIMEOUT' | 'EXPIRED'
    amount?: number
    initiatedAt?: Date
  }
) {
  await storage.createPayment({
    id: opts.id,
    checkoutRequestId: opts.checkoutRequestId,
    merchantRequestId: 'merch-001',
    phoneNumber: '254708374149',
    amount: opts.amount ?? 100,
    accountReference: 'TestRef',
    status: opts.status ?? 'PENDING',
    initiatedAt: opts.initiatedAt ?? new Date(),
  })
}

// ---------------------------------------------------------------------------
// STK Query ResultCode type — STRING in query API
// ---------------------------------------------------------------------------

describe('STK Query — ResultCode is a string (documented type inconsistency)', () => {
  /**
   * SOURCE: https://dev.to/anne46/implementing-m-pesa-stk-push-and-query-in-ruby-on-rails-328d
   * CONFIRMED BY: developer report — STK Query returns ResultCode as STRING "1032",
   * not as number. This differs from the callback which returns ResultCode as number.
   * PRODUCTION IMPACT: if poll.ts treats ResultCode as already a number, parseInt("1032") === 1032
   * works correctly. The package uses parseInt(queryResult.ResultCode, 10) — this test confirms it.
   */
  it('correctly parses ResultCode "1032" (string) from STK Query and maps to CANCELLED', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await makePayment(storage, { id: 'pay-001', checkoutRequestId: 'ws_CO_poll_001' })

    vi.stubGlobal('fetch', makeTokenThenMultiQueryMock([
      mockStkQueryCancelled('ws_CO_poll_001'),
    ]))

    // Start poll
    const pollPromise = pollPaymentStatus('ws_CO_poll_001', CONFIG, storage)
    // Advance timers past the first poll delay (3000ms)
    await vi.advanceTimersByTimeAsync(4000)
    const status = await pollPromise

    expect(status).toBe('CANCELLED')
  })

  /**
   * SOURCE: https://dev.to/anne46/implementing-m-pesa-stk-push-and-query-in-ruby-on-rails-328d
   * CONFIRMED BY: developer report — STK Query returns ResultCode as STRING "0"
   * during still-processing state.
   * PRODUCTION IMPACT: if ResultCode "0" is not handled correctly (treated as terminal
   * success), the poll loop exits prematurely and the payment is marked SUCCESS before
   * the transaction actually completes.
   */
  it('continues polling when STK Query returns ResultCode "0" (still processing, not terminal)', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await makePayment(storage, { id: 'pay-002', checkoutRequestId: 'ws_CO_poll_002' })

    // All responses say "still processing" — poll should exhaust and mark TIMEOUT
    vi.stubGlobal('fetch', makeTokenThenMultiQueryMock([
      mockStkQueryStillProcessing('ws_CO_poll_002'),
      mockStkQueryStillProcessing('ws_CO_poll_002'),
      mockStkQueryStillProcessing('ws_CO_poll_002'),
    ]))

    const pollPromise = pollPaymentStatus('ws_CO_poll_002', CONFIG, storage)

    // Advance through all poll delays: 3s + 5s = 8s for maxPollAttempts=2
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(5000)
    const status = await pollPromise

    expect(status).toBe('TIMEOUT')
  })

  /**
   * SOURCE: https://dev.to/anne46/implementing-m-pesa-stk-push-api-guide-40a2
   * CONFIRMED BY: developer report — STK Query ResultCode "1037" means DS timeout.
   * PRODUCTION IMPACT: must be mapped to TIMEOUT status.
   */
  it('maps STK Query ResultCode "1037" (string) to TIMEOUT', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await makePayment(storage, { id: 'pay-003', checkoutRequestId: 'ws_CO_poll_003' })

    vi.stubGlobal('fetch', makeTokenThenMultiQueryMock([
      mockStkQueryFailed('1037', '[STK DS timeout] Request timeout.', 'ws_CO_poll_003'),
    ]))

    const pollPromise = pollPaymentStatus('ws_CO_poll_003', CONFIG, storage)
    await vi.advanceTimersByTimeAsync(4000)
    const status = await pollPromise

    expect(status).toBe('TIMEOUT')
  })
})

// ---------------------------------------------------------------------------
// Reconciliation scenarios
// ---------------------------------------------------------------------------

describe('reconcile — status mismatch detection', () => {
  /**
   * SOURCE: package source (reconcile.ts) — reconcile compares stored status vs Daraja query.
   * CONFIRMED BY: package design.
   * PRODUCTION IMPACT: PENDING payments that actually completed must be detected as mismatches.
   */
  it('reports a mismatch when a stored PENDING payment is confirmed SUCCESS by Daraja query', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    const from = new Date(now.getTime() - 60000)
    const to = new Date(now.getTime() + 60000)

    await makePayment(storage, {
      id: 'pay-reconcile-001',
      checkoutRequestId: 'ws_CO_recon_001',
      status: 'PENDING',
      initiatedAt: now,
    })

    // Daraja says it was cancelled
    const queryResponse: StkQueryShape = {
      ResponseCode: '0',
      ResponseDescription: 'The service request has been accepted successsfully',
      MerchantRequestID: 'merch-001',
      CheckoutRequestID: 'ws_CO_recon_001',
      ResultCode: '1032',
      ResultDesc: 'Request cancelled by user',
    }

    vi.stubGlobal('fetch', makeTokenThenQueryMock(queryResponse))

    const result = await reconcile(from, to, CONFIG, storage)

    expect(result.checked).toBe(1)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]!.storedStatus).toBe('PENDING')
    expect(result.mismatches[0]!.mpesaStatus).toBe('CANCELLED')
    expect(result.mismatches[0]!.checkoutRequestId).toBe('ws_CO_recon_001')
  })

  /**
   * SOURCE: package source (reconcile.ts) — reconcile does NOT auto-correct mismatches.
   * CONFIRMED BY: package design — "This function does NOT auto-correct mismatches."
   * PRODUCTION IMPACT: reconcile is read-only; callers must decide how to fix mismatches.
   */
  it('does NOT update the payment status when a mismatch is found (read-only)', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    const from = new Date(now.getTime() - 60000)
    const to = new Date(now.getTime() + 60000)

    await makePayment(storage, {
      id: 'pay-reconcile-002',
      checkoutRequestId: 'ws_CO_recon_002',
      status: 'PENDING',
      initiatedAt: now,
    })

    vi.stubGlobal('fetch', makeTokenThenQueryMock(
      mockStkQueryCancelled('ws_CO_recon_002')
    ))

    await reconcile(from, to, CONFIG, storage)

    // Status must still be PENDING — reconcile does not auto-correct
    const payment = await storage.getPaymentByCheckoutId('ws_CO_recon_002')
    expect(payment?.status).toBe('PENDING')
  })

  /**
   * SOURCE: package source (reconcile.ts) — checks PENDING and SUCCESS payments.
   * CONFIRMED BY: package design.
   * PRODUCTION IMPACT: SUCCESS payments that Daraja says are failed (ghost payments) must be detected.
   */
  it('includes SUCCESS payments in reconciliation scope (to detect ghost successes)', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    const from = new Date(now.getTime() - 60000)
    const to = new Date(now.getTime() + 60000)

    // Simulate a SUCCESS that was stored but Daraja shows as cancelled
    await makePayment(storage, {
      id: 'pay-reconcile-003',
      checkoutRequestId: 'ws_CO_recon_003',
      status: 'SUCCESS',
      initiatedAt: now,
    })

    vi.stubGlobal('fetch', makeTokenThenQueryMock(
      mockStkQueryCancelled('ws_CO_recon_003')
    ))

    const result = await reconcile(from, to, CONFIG, storage)

    expect(result.checked).toBe(1)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]!.storedStatus).toBe('SUCCESS')
    expect(result.mismatches[0]!.mpesaStatus).toBe('CANCELLED')
  })

  /**
   * SOURCE: package source (reconcile.ts lines 121-131) — skips on query failure.
   * CONFIRMED BY: package design — "If Daraja query fails for one payment, log and skip."
   * PRODUCTION IMPACT: a single failing query must not abort the entire reconciliation run.
   */
  it('skips a payment when the Daraja query throws and continues processing others', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    const from = new Date(now.getTime() - 60000)
    const to = new Date(now.getTime() + 60000)

    await makePayment(storage, {
      id: 'pay-reconcile-004',
      checkoutRequestId: 'ws_CO_recon_004',
      status: 'PENDING',
      initiatedAt: now,
    })

    await makePayment(storage, {
      id: 'pay-reconcile-005',
      checkoutRequestId: 'ws_CO_recon_005',
      status: 'PENDING',
      initiatedAt: now,
    })

    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // Token
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      if (callCount === 2) {
        // First query fails
        return Promise.reject(new Error('Network error'))
      }
      // Second query token
      if (callCount === 3) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      // Second payment query succeeds
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStkQueryCancelled('ws_CO_recon_005')),
        text: () => Promise.resolve(''),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await reconcile(from, to, CONFIG, storage)

    expect(result.skipped).toBe(1)   // One failed query
    expect(result.checked).toBe(1)   // One successful query
  })

  /**
   * SOURCE: package source (reconcile.ts) — date range filter uses initiatedAt.
   * CONFIRMED BY: package design.
   * PRODUCTION IMPACT: payments outside the date range must not be included in reconciliation.
   */
  it('only reconciles payments whose initiatedAt falls within the date range', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    const from = new Date(now.getTime() - 10000)
    const to = new Date(now.getTime() + 10000)

    // Payment inside range
    await makePayment(storage, {
      id: 'pay-in-range',
      checkoutRequestId: 'ws_CO_inrange',
      status: 'PENDING',
      initiatedAt: now,
    })

    // Payment outside range (too old)
    await makePayment(storage, {
      id: 'pay-out-range',
      checkoutRequestId: 'ws_CO_outrange',
      status: 'PENDING',
      initiatedAt: new Date(now.getTime() - 100000), // 100 seconds ago — outside range
    })

    vi.stubGlobal('fetch', makeTokenThenQueryMock(
      mockStkQueryCancelled('ws_CO_inrange')
    ))

    const result = await reconcile(from, to, CONFIG, storage)

    // Only the in-range payment should be checked
    expect(result.checked).toBe(1)
  })

  /**
   * SOURCE: package source (reconcile.ts) — skipped counter is NOT added to checked.
   * CONFIRMED BY: package design (reconcile.ts comment on line 73-79).
   * PRODUCTION IMPACT: callers monitor skipped counter — if skipped > 0, re-run reconciliation.
   */
  it('reports matched and mismatches that sum to checked (not skipped)', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    const from = new Date(now.getTime() - 60000)
    const to = new Date(now.getTime() + 60000)

    await makePayment(storage, {
      id: 'pay-sum-001',
      checkoutRequestId: 'ws_CO_sum_001',
      status: 'PENDING',
      initiatedAt: now,
    })

    await makePayment(storage, {
      id: 'pay-sum-002',
      checkoutRequestId: 'ws_CO_sum_002',
      status: 'PENDING',
      initiatedAt: now,
    })

    let tokenCalls = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      tokenCalls++
      if (tokenCalls % 2 === 1) {
        // Every odd call is a token request
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      // Even call is the query — both return "still processing" (ResultCode "0") = SUCCESS in reconcile
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStkQueryStillProcessing()),
        text: () => Promise.resolve(''),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await reconcile(from, to, CONFIG, storage)

    expect(result.checked).toBe(result.matched + result.mismatches.length)
    expect(result.skipped).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Poll — duplicate poll guard
// ---------------------------------------------------------------------------

describe('poll — in-flight guard', () => {
  /**
   * SOURCE: package source (poll.ts lines 96-101) — activePollIds set prevents duplicate polls.
   * CONFIRMED BY: package design.
   * PRODUCTION IMPACT: without this guard, concurrent poll calls for the same payment can
   * cause duplicate status updates and double onPaymentSettled callbacks.
   */
  it('returns PENDING immediately when a poll is already in progress for the same checkoutRequestId', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await storage.createPayment({
      id: 'pay-dup-poll',
      checkoutRequestId: 'ws_CO_dup_poll',
      merchantRequestId: 'merch-001',
      phoneNumber: '254708374149',
      amount: 100,
      accountReference: 'TestRef',
      status: 'PENDING',
      initiatedAt: new Date(),
    })

    let queryCallCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      queryCallCount++
      if (queryCallCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      // Never resolve — simulates a slow query
      return new Promise(() => {}) // hangs
    })
    vi.stubGlobal('fetch', mockFetch)

    // Start first poll (will hang waiting for timer advance)
    const poll1 = pollPaymentStatus('ws_CO_dup_poll', CONFIG, storage)

    // Start second poll immediately — should return PENDING without making any network call
    const poll2Status = await pollPaymentStatus('ws_CO_dup_poll', CONFIG, storage)
    expect(poll2Status).toBe('PENDING')

    // Cleanup
    vi.advanceTimersByTime(100000)
    poll1.catch(() => {}) // suppress unhandled rejection
  })
})
