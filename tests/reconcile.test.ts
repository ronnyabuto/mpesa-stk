import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { MemoryAdapter } from '../src/adapters/memory.js'
import { reconcile } from '../src/reconcile.js'
import { clearTokenCache } from '../src/initiate.js'
import type { PaymentRecord, MpesaConfig } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const config: MpesaConfig = {
  consumerKey: 'test-key',
  consumerSecret: 'test-secret',
  shortCode: '174379',
  passKey: 'test-passkey',
  callbackUrl: 'https://example.com/callback',
  environment: 'sandbox',
}

const FROM = new Date('2024-11-01T00:00:00Z')
const TO = new Date('2024-11-01T23:59:59Z')

function makeRecord(id: string, checkoutId: string, overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id,
    checkoutRequestId: checkoutId,
    merchantRequestId: `merch-${id}`,
    phoneNumber: '254712345678',
    amount: 100,
    accountReference: `ORDER-${id}`,
    status: 'SUCCESS',
    initiatedAt: new Date('2024-11-01T10:00:00Z'),
    ...overrides,
  }
}

const tokenResponse = { access_token: 'test-token', expires_in: '3599' }

function queryResponse(resultCode: string, resultDesc: string) {
  return {
    ResponseCode: '0',
    ResponseDescription: 'Accepted',
    MerchantRequestID: 'merch-001',
    CheckoutRequestID: 'ws_CO_001',
    ResultCode: resultCode,
    ResultDesc: resultDesc,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  let adapter: MemoryAdapter

  beforeEach(() => {
    adapter = new MemoryAdapter()
    clearTokenCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearTokenCache()
  })

  it('all payments match — ReconciliationResult with 0 mismatches', async () => {
    await adapter.createPayment(makeRecord('p1', 'ws_CO_001', { status: 'SUCCESS' }))
    await adapter.createPayment(makeRecord('p2', 'ws_CO_002', { status: 'SUCCESS' }))

    // With token caching: first call fetches token (caches it), subsequent calls use cache.
    // So for 2 payments: token, query_p1, query_p2 = 3 fetch calls
    let callIndex = 0
    const responses = [
      tokenResponse,                               // call 1: token fetch (cached for subsequent)
      queryResponse('0', 'Processed successfully.'), // call 2: p1 query
      queryResponse('0', 'Processed successfully.'), // call 3: p2 query
    ]

    vi.stubGlobal('fetch', async () => {
      const body = responses[callIndex++] ?? {}
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    })

    const result = await reconcile(FROM, TO, config, adapter)

    expect(result.checked).toBe(2)
    expect(result.matched).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.mismatches).toHaveLength(0)
  })

  it('one payment is SUCCESS in DB but FAILED per Daraja — mismatch reported', async () => {
    await adapter.createPayment(makeRecord('p1', 'ws_CO_001', { status: 'SUCCESS' }))

    let callIndex = 0
    const responses = [
      tokenResponse,
      // Daraja returns a failure code — our DB says SUCCESS but Daraja disagrees
      queryResponse('1', 'Insufficient funds.'),
    ]

    vi.stubGlobal('fetch', async () => {
      const body = responses[callIndex++] ?? {}
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    })

    const result = await reconcile(FROM, TO, config, adapter)

    expect(result.checked).toBe(1)
    expect(result.matched).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]?.storedStatus).toBe('SUCCESS')
    expect(result.mismatches[0]?.mpesaStatus).toBe('FAILED')
    expect(result.mismatches[0]?.paymentId).toBe('p1')
  })

  it('date range has zero payments — returns checked=0, matched=0, skipped=0, mismatches=[]', async () => {
    // No payments created — storage returns empty arrays
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await reconcile(FROM, TO, config, adapter)

    expect(result.checked).toBe(0)
    expect(result.matched).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.mismatches).toHaveLength(0)
    // No Daraja calls should be made when there are no payments to check
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Daraja query fails for one payment — that payment skipped, others processed', async () => {
    await adapter.createPayment(makeRecord('p1', 'ws_CO_001', { status: 'SUCCESS' }))
    await adapter.createPayment(makeRecord('p2', 'ws_CO_002', { status: 'SUCCESS' }))

    // With token caching: token, query_p1 (throws), query_p2 (succeeds)
    let callIndex = 0

    vi.stubGlobal('fetch', async (_url: string, _opts: unknown) => {
      callIndex++
      if (callIndex === 1) {
        // Token fetch — succeeds and caches
        return { ok: true, status: 200, json: async () => tokenResponse, text: async () => '' }
      }
      if (callIndex === 2) {
        // p1 STK query — simulate network failure
        throw new Error('Network error for p1')
      }
      // callIndex === 3: p2 STK query — success (token already cached, no re-fetch)
      return {
        ok: true,
        status: 200,
        json: async () => queryResponse('0', 'Processed successfully.'),
        text: async () => '',
      }
    })

    const result = await reconcile(FROM, TO, config, adapter)

    // p1 was skipped (network error), p2 was checked and matched
    expect(result.checked).toBe(1)
    expect(result.matched).toBe(1)
    expect(result.skipped).toBe(1) // p1 skipped due to network error
    expect(result.mismatches).toHaveLength(0)
  })
})
