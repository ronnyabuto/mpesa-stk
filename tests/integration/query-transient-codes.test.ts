import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollPaymentStatus } from '../../src/poll.js'
import { reconcile } from '../../src/reconcile.js'
import { queryStkStatus, DarajaRateLimitError } from '../../src/daraja.js'
import { terminalQueryStatus } from '../../src/callback.js'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import { clearTokenCache } from '../../src/initiate.js'
import {
  mockTokenResponse,
  mockStkQueryTransient4999,
  mockStkQueryFailed,
  STK_QUERY_SPIKE_ARREST_BODY,
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
  reconcileQueryIntervalMs: 0, // keep reconcile tests fast
}

function tokenResp() {
  return { ok: true, status: 200, json: () => Promise.resolve(mockTokenResponse()), text: () => Promise.resolve('') } as Response
}
function jsonResp(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as Response
}
function rateLimitResp(retryAfter?: string) {
  return {
    ok: false,
    status: 429,
    headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    json: () => Promise.resolve(STK_QUERY_SPIKE_ARREST_BODY),
    text: () => Promise.resolve(JSON.stringify(STK_QUERY_SPIKE_ARREST_BODY)),
  } as unknown as Response
}

/** token first, then each query response in order (last one repeats). */
function tokenThenQueries(responses: StkQueryShape[]): typeof fetch {
  let i = 0
  return vi.fn().mockImplementation(() => {
    if (i === 0) { i++; return Promise.resolve(tokenResp()) }
    const r = responses[Math.min(i - 1, responses.length - 1)]
    i++
    return Promise.resolve(jsonResp(r))
  })
}

async function makePayment(storage: MemoryAdapter, id: string, checkoutRequestId: string, status: 'PENDING' = 'PENDING') {
  await storage.createPayment({
    id, checkoutRequestId, merchantRequestId: 'merch-001', phoneNumber: '254708374149',
    amount: 100, accountReference: 'TestRef', status, initiatedAt: new Date(),
  })
}

beforeEach(() => clearTokenCache())
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); clearTokenCache() })

// ---------------------------------------------------------------------------
// terminalQueryStatus — the closed allowlist
// ---------------------------------------------------------------------------

describe('terminalQueryStatus — only known codes are terminal', () => {
  it('maps known terminal codes', () => {
    expect(terminalQueryStatus(1032)).toBe('CANCELLED')
    expect(terminalQueryStatus(1037)).toBe('TIMEOUT')
    expect(terminalQueryStatus(1019)).toBe('EXPIRED')
    expect(terminalQueryStatus(1)).toBe('FAILED')
    expect(terminalQueryStatus(2001)).toBe('FAILED')
    expect(terminalQueryStatus(9999)).toBe('FAILED')
  })

  it('returns undefined for transient/in-flight/unknown codes (must NOT settle)', () => {
    expect(terminalQueryStatus(0)).toBeUndefined()    // in-progress (contextual)
    expect(terminalQueryStatus(4999)).toBeUndefined() // observed transient
    expect(terminalQueryStatus(8888)).toBeUndefined() // unrecognised
    expect(terminalQueryStatus(NaN)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Finding A — poll must NOT settle a transient code as FAILED
// ---------------------------------------------------------------------------

describe('poll — transient query codes do not settle the payment', () => {
  it('ResultCode "4999" keeps polling and exits TIMEOUT, not FAILED (regression)', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await makePayment(storage, 'pay-4999', 'ws_CO_4999')

    vi.stubGlobal('fetch', tokenThenQueries([mockStkQueryTransient4999('ws_CO_4999')]))

    const pollPromise = pollPaymentStatus('ws_CO_4999', CONFIG, storage)
    await vi.runAllTimersAsync() // walk the full poll backoff to exhaustion
    const status = await pollPromise

    expect(status).toBe('TIMEOUT')
    expect((await storage.getPayment('pay-4999'))?.status).toBe('TIMEOUT')
  })

  it('an unrecognised ResultCode keeps polling and exits TIMEOUT, not FAILED', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await makePayment(storage, 'pay-unknown', 'ws_CO_unknown')

    vi.stubGlobal('fetch', tokenThenQueries([mockStkQueryFailed('8888', 'Some new undocumented code', 'ws_CO_unknown')]))

    const pollPromise = pollPaymentStatus('ws_CO_unknown', CONFIG, storage)
    await vi.runAllTimersAsync()
    const status = await pollPromise

    expect(status).toBe('TIMEOUT')
  })

  it('still settles a genuinely terminal code (1037 → TIMEOUT) on the first query', async () => {
    vi.useFakeTimers()
    const storage = new MemoryAdapter()
    await makePayment(storage, 'pay-1037', 'ws_CO_1037')

    vi.stubGlobal('fetch', tokenThenQueries([mockStkQueryFailed('1037', 'DS timeout user cannot be reached.', 'ws_CO_1037')]))

    const pollPromise = pollPaymentStatus('ws_CO_1037', CONFIG, storage)
    await vi.runAllTimersAsync()
    const status = await pollPromise

    expect(status).toBe('TIMEOUT')
  })
})

// ---------------------------------------------------------------------------
// Finding A — reconcile must skip (not fabricate a mismatch) on a transient code
// ---------------------------------------------------------------------------

describe('reconcile — transient query code is skipped, not reported as mismatch', () => {
  it('ResultCode "4999" → skipped, no mismatch (regression)', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    await makePayment(storage, 'pay-r4999', 'ws_CO_r4999')

    vi.stubGlobal('fetch', tokenThenQueries([mockStkQueryTransient4999('ws_CO_r4999')]))

    const result = await reconcile(new Date(now.getTime() - 60000), new Date(now.getTime() + 60000), CONFIG, storage)

    expect(result.skipped).toBe(1)
    expect(result.checked).toBe(0)
    expect(result.mismatches).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Finding B — 429 SpikeArrest handling
// ---------------------------------------------------------------------------

describe('queryStkStatus — 429 surfaces a typed, retryable error', () => {
  it('throws DarajaRateLimitError and parses Retry-After seconds → ms', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      call++
      return Promise.resolve(call === 1 ? tokenResp() : rateLimitResp('2'))
    }))

    await expect(queryStkStatus(CONFIG, 'ws_CO_429', 5000)).rejects.toMatchObject({
      name: 'DarajaRateLimitError',
      status: 429,
      retryAfterMs: 2000,
    })
  })
})

describe('reconcile — backs off on 429 then verifies the payment (not skipped)', () => {
  it('retries the same payment after a 429 and reports it as checked', async () => {
    const storage = new MemoryAdapter()
    const now = new Date()
    await makePayment(storage, 'pay-bo', 'ws_CO_bo')

    // token, then 429 (Retry-After 0 → near-instant backoff), then a terminal 1032
    let call = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      call++
      if (call === 1) return Promise.resolve(tokenResp())
      if (call === 2) return Promise.resolve(rateLimitResp('0'))
      return Promise.resolve(jsonResp(mockStkQueryFailed('1032', 'Request cancelled by user', 'ws_CO_bo')))
    }))

    const result = await reconcile(new Date(now.getTime() - 60000), new Date(now.getTime() + 60000), CONFIG, storage)

    expect(result.skipped).toBe(0)
    expect(result.checked).toBe(1)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]!.mpesaStatus).toBe('CANCELLED')
    expect(call).toBe(3) // token + 429 + successful retry
  })
})
