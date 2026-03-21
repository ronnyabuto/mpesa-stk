import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalisePhoneNumber, initiateStkPush, clearTokenCache } from '../src/initiate.js'
import { MemoryAdapter } from '../src/adapters/memory.js'
import { MpesaStk } from '../src/client.js'
import type { MpesaConfig } from '../src/types.js'

// ---------------------------------------------------------------------------
// normalisePhoneNumber
// ---------------------------------------------------------------------------

describe('normalisePhoneNumber', () => {
  it('07xxxxxxxx → 2547xxxxxxxx', () => {
    expect(normalisePhoneNumber('0712345678')).toBe('254712345678')
  })

  it('+254712345678 → 254712345678', () => {
    expect(normalisePhoneNumber('+254712345678')).toBe('254712345678')
  })

  it('254712345678 → 254712345678 (already normalised)', () => {
    expect(normalisePhoneNumber('254712345678')).toBe('254712345678')
  })

  it('0112345678 (Airtel Kenya) → 2541 12345678', () => {
    expect(normalisePhoneNumber('0112345678')).toBe('254112345678')
  })

  it('0100000000 (Telkom Kenya) → 2541 00000000', () => {
    expect(normalisePhoneNumber('0100000000')).toBe('254100000000')
  })

  it('712345678 (no leading zero or country code) — throws', () => {
    expect(() => normalisePhoneNumber('712345678')).toThrow(/Invalid phone number/)
  })

  it('+1 415 555 0123 (US number) — throws', () => {
    expect(() => normalisePhoneNumber('+1 415 555 0123')).toThrow(/Invalid phone number/)
  })

  it('07123456789 (too many digits) — throws', () => {
    expect(() => normalisePhoneNumber('07123456789')).toThrow(/Invalid phone number/)
  })
})

// ---------------------------------------------------------------------------
// Amount validation inside initiateStkPush
// ---------------------------------------------------------------------------

const config: MpesaConfig = {
  consumerKey: 'test-key',
  consumerSecret: 'test-secret',
  shortCode: '174379',
  passKey: 'test-passkey',
  callbackUrl: 'https://example.com/callback',
  environment: 'sandbox',
}

const tokenResponse = { access_token: 'test-token', expires_in: '3599' }
const stkPushSuccess = {
  MerchantRequestID: 'merch-001',
  CheckoutRequestID: 'ws_CO_001',
  ResponseCode: '0',
  ResponseDescription: 'Success',
  CustomerMessage: 'Success',
}

afterEach(() => {
  vi.restoreAllMocks()
  clearTokenCache()
})

describe('initiateStkPush — amount validation', () => {
  it('amount: 0 — throws before hitting Daraja', async () => {
    await expect(
      initiateStkPush(config, {
        phoneNumber: 'test',
        normalisedPhone: '254712345678',
        amount: 0,
        accountReference: 'REF',
        description: 'Test',
      })
    ).rejects.toThrow(/positive integer/)
  })

  it('amount: -50 — throws before hitting Daraja', async () => {
    await expect(
      initiateStkPush(config, {
        phoneNumber: 'test',
        normalisedPhone: '254712345678',
        amount: -50,
        accountReference: 'REF',
        description: 'Test',
      })
    ).rejects.toThrow(/positive integer/)
  })

  it('amount: 100.50 (float) — throws before hitting Daraja', async () => {
    await expect(
      initiateStkPush(config, {
        phoneNumber: 'test',
        normalisedPhone: '254712345678',
        amount: 100.5,
        accountReference: 'REF',
        description: 'Test',
      })
    ).rejects.toThrow(/positive integer/)
  })

  it('amount: NaN — throws before hitting Daraja', async () => {
    await expect(
      initiateStkPush(config, {
        phoneNumber: 'test',
        normalisedPhone: '254712345678',
        amount: NaN,
        accountReference: 'REF',
        description: 'Test',
      })
    ).rejects.toThrow(/positive integer/)
  })

  it('amount: Infinity — throws before hitting Daraja', async () => {
    await expect(
      initiateStkPush(config, {
        phoneNumber: 'test',
        normalisedPhone: '254712345678',
        amount: Infinity,
        accountReference: 'REF',
        description: 'Test',
      })
    ).rejects.toThrow(/positive integer/)
  })
})

// ---------------------------------------------------------------------------
// Daraja STK Push error response shape (errorCode / errorMessage)
// ---------------------------------------------------------------------------

describe('initiateStkPush — Daraja error response', () => {
  it('Daraja returns errorCode/errorMessage — throws with errorCode in message', async () => {
    // Provide token response first, then the error response from STK push endpoint
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
      callCount++
      if (callCount === 1) {
        // Token fetch
        return {
          ok: true,
          status: 200,
          json: async () => tokenResponse,
          text: async () => JSON.stringify(tokenResponse),
        }
      }
      // STK push — Daraja returns errorCode shape with non-200
      return {
        ok: false,
        status: 400,
        json: async () => ({
          requestId: 'req-001',
          errorCode: '400.002.02',
          errorMessage: 'Bad Request - Invalid BusinessShortCode',
        }),
        text: async () => '',
      }
    })

    await expect(
      initiateStkPush(config, {
        phoneNumber: 'test',
        normalisedPhone: '254712345678',
        amount: 100,
        accountReference: 'REF',
        description: 'Test',
      })
    ).rejects.toThrow(/400\.002\.02/)
  })

  it('Daraja returns errorCode/errorMessage on a 200 response — still throws', async () => {
    // Daraja sometimes returns error shapes with HTTP 200.
    // Token is served first, then the STK push returns an error body.
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
      callCount++
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => tokenResponse,
          text: async () => JSON.stringify(tokenResponse),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          requestId: 'req-001',
          errorCode: '500.001.1001',
          errorMessage: 'Unable to lock subscriber, a transaction is already in process for the current subscriber',
        }),
        text: async () => '',
      }
    })

    await expect(
      initiateStkPush(config, {
        phoneNumber: 'test',
        normalisedPhone: '254712345678',
        amount: 100,
        accountReference: 'REF',
        description: 'Test',
      })
    ).rejects.toThrow(/500\.001\.1001/)
  })
})

// ---------------------------------------------------------------------------
// Idempotency key — initiatePayment called twice with same key
// ---------------------------------------------------------------------------

describe('MpesaStk.initiatePayment — idempotency key', () => {
  it('second call with same idempotencyKey returns existing record without calling Daraja again', async () => {
    let fetchCallCount = 0
    vi.stubGlobal('fetch', async () => {
      fetchCallCount++
      if (fetchCallCount === 1) {
        // Token fetch
        return {
          ok: true,
          status: 200,
          json: async () => tokenResponse,
          text: async () => JSON.stringify(tokenResponse),
        }
      }
      // STK Push
      return {
        ok: true,
        status: 200,
        json: async () => stkPushSuccess,
        text: async () => JSON.stringify(stkPushSuccess),
      }
    })

    const adapter = new MemoryAdapter()
    const mpesa = new MpesaStk(config, adapter)

    const params = {
      phoneNumber: '0712345678',
      amount: 100,
      accountReference: 'ORDER-1',
      description: 'Test payment',
      idempotencyKey: 'order-abc-123',
    }

    // First call — should hit Daraja (token + STK push = 2 fetch calls)
    const result1 = await mpesa.initiatePayment(params)
    const callsAfterFirst = fetchCallCount

    expect(callsAfterFirst).toBe(2)
    expect(result1.checkoutRequestId).toBe('ws_CO_001')

    // Second call with same idempotency key — must NOT call Daraja
    const result2 = await mpesa.initiatePayment(params)
    expect(fetchCallCount).toBe(callsAfterFirst) // no new fetch calls

    // Both results must refer to the same payment
    expect(result2.paymentId).toBe(result1.paymentId)
    expect(result2.checkoutRequestId).toBe(result1.checkoutRequestId)
  })
})
