import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MpesaStk } from '../../src/client.js'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import { clearTokenCache } from '../../src/initiate.js'
import { mockCallbackSuccess, mockTokenResponse, mockStkPushSuccess } from './helpers/mocks.js'
import type { MpesaConfig, PaymentRecord } from '../../src/types.js'

const CONFIG: MpesaConfig = {
  consumerKey: 'k', consumerSecret: 's', shortCode: '174379',
  passKey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  callbackUrl: 'https://example.com/cb', environment: 'sandbox',
}

function pending(checkoutRequestId: string, over: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: `pay-${checkoutRequestId}`, checkoutRequestId, merchantRequestId: 'm-1',
    phoneNumber: '254708374149', amount: 100, accountReference: 'ORDER-1',
    status: 'PENDING', initiatedAt: new Date(), ...over,
  }
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve() }

beforeEach(() => clearTokenCache())
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); clearTokenCache() })

// ---------------------------------------------------------------------------
// Safaricom fires the same callback 2–4 times under load — CONCURRENTLY.
// The whole reason for the CAS (vs read-then-check) is this race. Sequential
// tests never create it; these fire the duplicates at once.
// ---------------------------------------------------------------------------

describe('concurrent duplicate callbacks — atomic CAS dedup', () => {
  it('4 simultaneous identical success callbacks settle exactly once', async () => {
    const adapter = new MemoryAdapter()
    const mpesa = new MpesaStk(CONFIG, adapter)
    await adapter.createPayment(pending('ws_CO_race'))

    const settled = vi.fn()
    mpesa.onPaymentSettled(settled)

    const cb = mockCallbackSuccess({ checkoutRequestId: 'ws_CO_race', amount: 100, receipt: 'NLJ7RT61SV' })

    const results = await Promise.all([
      mpesa.processCallback(cb), mpesa.processCallback(cb),
      mpesa.processCallback(cb), mpesa.processCallback(cb),
    ])
    await flush()

    const winners = results.filter((r) => !r.isDuplicate)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.status).toBe('SUCCESS')
    // onPaymentSettled must fire exactly once, no matter how many duplicates raced.
    expect(settled).toHaveBeenCalledTimes(1)
    expect((await adapter.getPayment('pay-ws_CO_race'))?.status).toBe('SUCCESS')
  })

  it('a success and a late failure callback racing concurrently never downgrade the success', async () => {
    const adapter = new MemoryAdapter()
    const mpesa = new MpesaStk(CONFIG, adapter)
    await adapter.createPayment(pending('ws_CO_race2'))

    const successCb = mockCallbackSuccess({ checkoutRequestId: 'ws_CO_race2', amount: 100 })
    const failureCb = {
      Body: { stkCallback: { MerchantRequestID: 'm-1', CheckoutRequestID: 'ws_CO_race2', ResultCode: 1032, ResultDesc: 'Cancelled' } },
    }

    const results = await Promise.all([mpesa.processCallback(successCb), mpesa.processCallback(failureCb)])
    await flush()

    const final = (await adapter.getPayment('pay-ws_CO_race2'))?.status
    // Whichever won, the record is terminal and consistent; if SUCCESS won it is
    // never overwritten to CANCELLED, and exactly one result is the non-duplicate winner.
    expect(results.filter((r) => !r.isDuplicate)).toHaveLength(1)
    expect(['SUCCESS', 'CANCELLED']).toContain(final)
    // The winner's status equals the stored status — no torn write.
    expect(results.find((r) => !r.isDuplicate)!.status).toBe(final)
  })
})

// ---------------------------------------------------------------------------
// Idempotent initiation under TRUE concurrency. A double-tap on "Pay" or a
// retried HTTP request fires two initiations for the same key at once. The
// README promises this hits Daraja only once. Sequential tests never check it.
// ---------------------------------------------------------------------------

describe('concurrent idempotent initiation — single Daraja call', () => {
  it('4 simultaneous initiatePayment calls with the same key trigger ONE STK Push', async () => {
    let stkPushCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/')) {
        return { ok: true, status: 200, json: async () => mockTokenResponse(), text: async () => '' } as Response
      }
      // Slight delay widens the in-flight window, mimicking real Daraja latency.
      await new Promise((r) => setTimeout(r, 5))
      stkPushCalls++
      return { ok: true, status: 200, json: async () => mockStkPushSuccess(), text: async () => '' } as Response
    }))

    const adapter = new MemoryAdapter()
    const mpesa = new MpesaStk(CONFIG, adapter)

    const params = {
      phoneNumber: '0712345678', amount: 100, accountReference: 'ORDER-9',
      description: 'double-tap', idempotencyKey: 'ORDER-9',
    }

    const results = await Promise.all([
      mpesa.initiatePayment(params), mpesa.initiatePayment(params),
      mpesa.initiatePayment(params), mpesa.initiatePayment(params),
    ])

    // Exactly one charge reaches Daraja...
    expect(stkPushCalls).toBe(1)
    // ...and every caller gets the same payment back.
    const ids = new Set(results.map((r) => r.paymentId))
    expect(ids.size).toBe(1)
    const checkoutIds = new Set(results.map((r) => r.checkoutRequestId))
    expect(checkoutIds.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Poll vs callback racing to settle the same payment — both paths use the CAS.
// ---------------------------------------------------------------------------

describe('poll and callback racing to settle', () => {
  it('a callback arriving while a poll is mid-flight settles exactly once', async () => {
    vi.useFakeTimers()
    const adapter = new MemoryAdapter()
    const mpesa = new MpesaStk({ ...CONFIG, maxPollAttempts: 2 }, adapter)
    await adapter.createPayment(pending('ws_CO_pollrace'))

    const settled = vi.fn()
    mpesa.onPaymentSettled(settled)

    // STK query keeps saying "still processing"; the callback wins via CAS.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/')) {
        return { ok: true, status: 200, json: async () => mockTokenResponse(), text: async () => '' } as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({ ResponseCode: '0', ResultCode: '0', ResultDesc: 'processing', MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_pollrace', ResponseDescription: 'ok' }),
        text: async () => '',
      } as Response
    }))

    const pollPromise = mpesa.pollPaymentStatus('ws_CO_pollrace')
    await vi.advanceTimersByTimeAsync(1500) // mid first poll sleep
    // Callback lands while the poll loop sleeps.
    const cbResult = await mpesa.processCallback(mockCallbackSuccess({ checkoutRequestId: 'ws_CO_pollrace', amount: 100 }))
    await vi.advanceTimersByTimeAsync(10_000)
    const pollStatus = await pollPromise
    await flush()

    expect(cbResult.isDuplicate).toBe(false)
    expect(cbResult.status).toBe('SUCCESS')
    expect(pollStatus).toBe('SUCCESS') // poll observes the winner, does not re-settle
    expect(settled).toHaveBeenCalledTimes(1) // exactly once across both paths
  })
})
