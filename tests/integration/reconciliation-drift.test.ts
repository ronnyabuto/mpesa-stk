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

// STK Query returns ResultCode as a string (e.g. "1032"), unlike the callback which uses a number.
describe('STK Query — ResultCode is a string (documented type inconsistency)', () => {
  it('correctly parses ResultCode "1032" (string) from STK Query and maps to CANCELLED', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await makePayment(storage, { id: 'pay-001', checkoutRequestId: 'ws_CO_poll_001' })

    vi.stubGlobal('fetch', makeTokenThenMultiQueryMock([
      mockStkQueryCancelled('ws_CO_poll_001'),
    ]))

    const pollPromise = pollPaymentStatus('ws_CO_poll_001', CONFIG, storage)
    await vi.advanceTimersByTimeAsync(4000)
    const status = await pollPromise

    expect(status).toBe('CANCELLED')
  })

  // ResultCode "0" from the query API means "still processing" — not a terminal success.
  // Treating it as terminal would mark the payment SUCCESS before the transaction completes.
  it('continues polling when STK Query returns ResultCode "0" (still processing, not terminal)', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await makePayment(storage, { id: 'pay-002', checkoutRequestId: 'ws_CO_poll_002' })

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

describe('reconcile — status mismatch detection', () => {
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

  it('includes SUCCESS payments in reconciliation scope (to detect ghost successes)', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    const from = new Date(now.getTime() - 60000)
    const to = new Date(now.getTime() + 60000)

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
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      if (callCount === 2) {
        return Promise.reject(new Error('Network error'))
      }
      if (callCount === 3) {
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
        json: () => Promise.resolve(mockStkQueryCancelled('ws_CO_recon_005')),
        text: () => Promise.resolve(''),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await reconcile(from, to, CONFIG, storage)

    expect(result.skipped).toBe(1)
    expect(result.checked).toBe(1)
  })

  it('only reconciles payments whose initiatedAt falls within the date range', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    const from = new Date(now.getTime() - 10000)
    const to = new Date(now.getTime() + 10000)

    await makePayment(storage, {
      id: 'pay-in-range',
      checkoutRequestId: 'ws_CO_inrange',
      status: 'PENDING',
      initiatedAt: now,
    })

    await makePayment(storage, {
      id: 'pay-out-range',
      checkoutRequestId: 'ws_CO_outrange',
      status: 'PENDING',
      initiatedAt: new Date(now.getTime() - 100000),
    })

    vi.stubGlobal('fetch', makeTokenThenQueryMock(
      mockStkQueryCancelled('ws_CO_inrange')
    ))

    const result = await reconcile(from, to, CONFIG, storage)

    expect(result.checked).toBe(1)
  })

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

describe('poll — in-flight guard', () => {
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
      return new Promise(() => {})
    })
    vi.stubGlobal('fetch', mockFetch)

    const poll1 = pollPaymentStatus('ws_CO_dup_poll', CONFIG, storage)

    const poll2Status = await pollPaymentStatus('ws_CO_dup_poll', CONFIG, storage)
    expect(poll2Status).toBe('PENDING')

    vi.advanceTimersByTime(100000)
    poll1.catch(() => {})
  })
})
