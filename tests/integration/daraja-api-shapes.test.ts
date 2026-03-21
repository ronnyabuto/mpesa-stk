/**
 * daraja-api-shapes.test.ts
 *
 * Tests that verify the package correctly handles the real Daraja API request
 * and response shapes as documented in developer sources.
 *
 * Every test cites the source that confirmed the behavior under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mockTokenResponse,
  mockStkPushSuccess,
  mockStkPushError,
  makeTokenThenApiMock,
  mockCallbackSuccess,
  mockCallbackFailure,
} from './helpers/mocks.js'
import { MpesaStk } from '../../src/client.js'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import {
  fetchAccessToken,
  clearTokenCache,
  initiateStkPush,
  getBaseUrl,
} from '../../src/initiate.js'
import type { MpesaConfig } from '../../src/types.js'

const SANDBOX_CONFIG: MpesaConfig = {
  consumerKey: 'test-consumer-key',
  consumerSecret: 'test-consumer-secret',
  shortCode: '174379',
  passKey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  callbackUrl: 'https://example.com/mpesa/callback',
  environment: 'sandbox',
}

const PRODUCTION_CONFIG: MpesaConfig = {
  ...SANDBOX_CONFIG,
  environment: 'production',
}

describe('Daraja API URL routing', () => {
  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * SOURCE: multiple developer guides confirming sandbox vs production base URLs
   * CONFIRMED BY: developer docs
   * PRODUCTION IMPACT: wrong base URL sends real money requests to sandbox or vice versa.
   */
  it('uses sandbox base URL https://sandbox.safaricom.co.ke for sandbox environment', () => {
    expect(getBaseUrl('sandbox')).toBe('https://sandbox.safaricom.co.ke')
  })

  it('uses production base URL https://api.safaricom.co.ke for production environment', () => {
    /**
     * SOURCE: multiple developer guides (https://dev.to/msnmongare/how-to-go-live-with-m-pesa-daraja-api-production-environment-4h96)
     * CONFIRMED BY: developer report — production base URL
     */
    expect(getBaseUrl('production')).toBe('https://api.safaricom.co.ke')
  })
})

describe('OAuth token endpoint', () => {
  beforeEach(() => {
    clearTokenCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearTokenCache()
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — token endpoint uses GET method with Basic Auth header
   * PRODUCTION IMPACT: POST to this endpoint returns 405; wrong method blocks all API calls.
   */
  it('calls OAuth token endpoint with GET method', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockTokenResponse()),
      text: () => Promise.resolve(''),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    await fetchAccessToken(SANDBOX_CONFIG)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(options.method).toBe('GET')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — endpoint uses Basic Auth with base64(consumerKey:consumerSecret)
   * PRODUCTION IMPACT: any other auth scheme (Bearer, etc.) returns 401 for all API calls.
   */
  it('sends Basic Auth header with base64-encoded consumerKey:consumerSecret', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockTokenResponse()),
      text: () => Promise.resolve(''),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    await fetchAccessToken(SANDBOX_CONFIG)

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    const authHeader = (options.headers as Record<string, string>)['Authorization']
    const expectedCredentials = Buffer.from(
      `${SANDBOX_CONFIG.consumerKey}:${SANDBOX_CONFIG.consumerSecret}`
    ).toString('base64')
    expect(authHeader).toBe(`Basic ${expectedCredentials}`)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs
   * PRODUCTION IMPACT: token endpoint path is specific — wrong path returns 404.
   */
  it('calls the correct sandbox token endpoint URL with grant_type query param', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockTokenResponse()),
      text: () => Promise.resolve(''),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    await fetchAccessToken(SANDBOX_CONFIG)

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    )
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — expires_in is returned as a STRING "3600", not a number.
   * PRODUCTION IMPACT: parseInt("3600") must be used to compute expiry. If the field is
   * treated as a number and compared directly, NaN bugs can arise.
   */
  it('correctly parses expires_in as string "3600" and caches the token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: 'my-token', expires_in: '3600' }),
      text: () => Promise.resolve(''),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    const token = await fetchAccessToken(SANDBOX_CONFIG)
    expect(token).toBe('my-token')

    // Should serve from cache on second call
    const token2 = await fetchAccessToken(SANDBOX_CONFIG)
    expect(token2).toBe('my-token')
    expect(mockFetch).toHaveBeenCalledTimes(1) // only one HTTP call — cache hit
  })

  /**
   * SOURCE: https://github.com/safaricom/mpesa-php-sdk/issues (issue #59)
   * CONFIRMED BY: github issue — sandbox OAuth endpoint returning 503 under load
   * PRODUCTION IMPACT: if token fetch throws, all STK Push initiations fail.
   */
  it('throws a descriptive error when OAuth endpoint returns non-200 (e.g. 503)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error('not JSON')),
      text: () => Promise.resolve('Service Unavailable'),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchAccessToken(SANDBOX_CONFIG)).rejects.toThrow('503')
  })
})

describe('STK Push initiation request shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearTokenCache()
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — full list of required STK Push request fields
   * PRODUCTION IMPACT: missing any field returns 400 Bad Request.
   */
  it('sends all required STK Push fields in the request body', async () => {
    let capturedBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
      if (String(url).includes('/oauth/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      // Capture the STK Push body
      capturedBody = JSON.parse(options.body as string)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStkPushSuccess()),
        text: () => Promise.resolve(''),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    await initiateStkPush(SANDBOX_CONFIG, {
      phoneNumber: '254708374149',
      normalisedPhone: '254708374149',
      amount: 100,
      accountReference: 'TestRef001',
      description: 'Test payment',
    })

    expect(capturedBody).not.toBeNull()
    const body = capturedBody!

    // All fields documented in the official API spec
    expect(body).toHaveProperty('BusinessShortCode', '174379')
    expect(body).toHaveProperty('Password')
    expect(body).toHaveProperty('Timestamp')
    expect(body).toHaveProperty('TransactionType', 'CustomerPayBillOnline')
    expect(body).toHaveProperty('Amount', 100)
    expect(body).toHaveProperty('PartyA', '254708374149')
    expect(body).toHaveProperty('PartyB', '174379')
    expect(body).toHaveProperty('PhoneNumber', '254708374149')
    expect(body).toHaveProperty('CallBackURL', 'https://example.com/mpesa/callback')
    expect(body).toHaveProperty('AccountReference', 'TestRef001')
    expect(body).toHaveProperty('TransactionDesc', 'Test payment')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — Password = base64(ShortCode + PassKey + Timestamp)
   * PRODUCTION IMPACT: wrong password format returns 404.001.03 Invalid Access Token.
   */
  it('generates Password as base64(shortCode + passKey + timestamp)', async () => {
    let capturedBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
      if (String(url).includes('/oauth/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      capturedBody = JSON.parse(options.body as string)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStkPushSuccess()),
        text: () => Promise.resolve(''),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    await initiateStkPush(SANDBOX_CONFIG, {
      phoneNumber: '254708374149',
      normalisedPhone: '254708374149',
      amount: 100,
      accountReference: 'TestRef',
      description: 'Test',
    })

    const timestamp = (capturedBody as Record<string, unknown>)['Timestamp'] as string
    const password = (capturedBody as Record<string, unknown>)['Password'] as string

    const expectedPassword = Buffer.from(
      `${SANDBOX_CONFIG.shortCode}${SANDBOX_CONFIG.passKey}${timestamp}`
    ).toString('base64')
    expect(password).toBe(expectedPassword)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — Timestamp must be EAT (UTC+3) in YYYYMMDDHHmmss format
   * PRODUCTION IMPACT: wrong timezone or format returns "Bad Request — Invalid Timestamp".
   */
  it('sends Timestamp in YYYYMMDDHHmmss format (14 digits)', async () => {
    let capturedBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
      if (String(url).includes('/oauth/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      capturedBody = JSON.parse(options.body as string)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStkPushSuccess()),
        text: () => Promise.resolve(''),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    await initiateStkPush(SANDBOX_CONFIG, {
      phoneNumber: '254708374149',
      normalisedPhone: '254708374149',
      amount: 100,
      accountReference: 'TestRef',
      description: 'Test',
    })

    const timestamp = (capturedBody as Record<string, unknown>)['Timestamp'] as string
    expect(timestamp).toMatch(/^\d{14}$/)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — Amount must be a whole number (integer).
   * PRODUCTION IMPACT: fractional amounts cause API rejection; financial systems
   * storing float amounts risk subtle bugs.
   */
  it('rejects fractional (non-integer) amounts before sending to Daraja', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/oauth/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      return Promise.reject(new Error('Should not reach STK Push'))
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      initiateStkPush(SANDBOX_CONFIG, {
        phoneNumber: '254708374149',
        normalisedPhone: '254708374149',
        amount: 99.5,
        accountReference: 'TestRef',
        description: 'Test',
      })
    ).rejects.toThrow(/positive integer/)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — PartyB is the organization's shortcode for paybill.
   * For CustomerPayBillOnline, PartyB = BusinessShortCode.
   * PRODUCTION IMPACT: wrong PartyB routes funds to wrong account.
   */
  it('sets PartyB equal to shortCode for CustomerPayBillOnline (paybill)', async () => {
    let capturedBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
      if (String(url).includes('/oauth/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockTokenResponse()),
          text: () => Promise.resolve(''),
        } as Response)
      }
      capturedBody = JSON.parse(options.body as string)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStkPushSuccess()),
        text: () => Promise.resolve(''),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    await initiateStkPush(SANDBOX_CONFIG, {
      phoneNumber: '254708374149',
      normalisedPhone: '254708374149',
      amount: 100,
      accountReference: 'TestRef',
      description: 'Test',
    })

    const body = capturedBody!
    expect(body['PartyB']).toBe(SANDBOX_CONFIG.shortCode)
    expect(body['BusinessShortCode']).toBe(SANDBOX_CONFIG.shortCode)
    expect(body['TransactionType']).toBe('CustomerPayBillOnline')
  })
})

describe('STK Push initiation response handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearTokenCache()
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * CONFIRMED BY: developer docs — success response includes these exact fields.
   * PRODUCTION IMPACT: CheckoutRequestID is required for STK Query — must be persisted.
   */
  it('extracts MerchantRequestID and CheckoutRequestID from success response', async () => {
    const successResponse = mockStkPushSuccess({
      MerchantRequestID: '29115-34620561-1',
      CheckoutRequestID: 'ws_CO_191220191020363925',
    })
    vi.stubGlobal('fetch', makeTokenThenApiMock(successResponse))

    const result = await initiateStkPush(SANDBOX_CONFIG, {
      phoneNumber: '254708374149',
      normalisedPhone: '254708374149',
      amount: 100,
      accountReference: 'TestRef',
      description: 'Test',
    })

    expect(result.merchantRequestId).toBe('29115-34620561-1')
    expect(result.checkoutRequestId).toBe('ws_CO_191220191020363925')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — ResponseCode "0" means request accepted.
   * Non-"0" ResponseCode means the API rejected the request entirely.
   * PRODUCTION IMPACT: non-"0" ResponseCode must not be silently treated as success.
   */
  it('throws when ResponseCode is non-"0" even if HTTP status is 200', async () => {
    const rejectedResponse = mockStkPushSuccess({ ResponseCode: '1', ResponseDescription: 'Rejected' })
    vi.stubGlobal('fetch', makeTokenThenApiMock(rejectedResponse))

    await expect(
      initiateStkPush(SANDBOX_CONFIG, {
        phoneNumber: '254708374149',
        normalisedPhone: '254708374149',
        amount: 100,
        accountReference: 'TestRef',
        description: 'Test',
      })
    ).rejects.toThrow(/ResponseCode/)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — error response shape uses errorCode/errorMessage.
   * PRODUCTION IMPACT: if error response is parsed as success, a missing CheckoutRequestID
   * causes null pointer errors downstream.
   */
  it('throws when Daraja returns an error response with errorCode field', async () => {
    const errorResponse = mockStkPushError('400.002.02', 'Bad Request - Invalid BusinessShortCode')
    vi.stubGlobal('fetch', makeTokenThenApiMock(errorResponse, 400))

    await expect(
      initiateStkPush(SANDBOX_CONFIG, {
        phoneNumber: '254708374149',
        normalisedPhone: '254708374149',
        amount: 100,
        accountReference: 'TestRef',
        description: 'Test',
      })
    ).rejects.toThrow('400.002.02')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — STK Push endpoint path
   * PRODUCTION IMPACT: wrong path returns 404.
   */
  it('calls the sandbox STK Push endpoint at the correct path', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/oauth/')) {
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
        json: () => Promise.resolve(mockStkPushSuccess()),
        text: () => Promise.resolve(''),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    await initiateStkPush(SANDBOX_CONFIG, {
      phoneNumber: '254708374149',
      normalisedPhone: '254708374149',
      amount: 100,
      accountReference: 'TestRef',
      description: 'Test',
    })

    const calls = (mockFetch.mock.calls as [string, RequestInit][])
    const stkCall = calls.find(([url]) => url.includes('stkpush'))
    expect(stkCall).toBeDefined()
    expect(stkCall![0]).toBe(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
    )
    expect(stkCall![1].method).toBe('POST')
  })
})

describe('Idempotency', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearTokenCache()
  })

  /**
   * SOURCE: package design — idempotencyKey param is explicitly supported.
   * CONFIRMED BY: package source (client.ts lines 68-81)
   * PRODUCTION IMPACT: duplicate STK Push calls to same phone without idempotency key
   * can cause multiple USSD prompts. With idempotencyKey, second call returns existing record.
   */
  it('returns the existing payment record when the same idempotencyKey is used twice', async () => {
    const storage = new MemoryAdapter()
    const client = new MpesaStk(SANDBOX_CONFIG, storage)

    vi.stubGlobal('fetch', makeTokenThenApiMock(mockStkPushSuccess()))

    const first = await client.initiatePayment({
      phoneNumber: '254708374149',
      amount: 100,
      accountReference: 'TestRef',
      description: 'Test',
      idempotencyKey: 'order-abc-123',
    })

    // Reset mock for the second call — should NOT be called again
    const mockFetch2 = vi.fn()
    vi.stubGlobal('fetch', mockFetch2)

    const second = await client.initiatePayment({
      phoneNumber: '254708374149',
      amount: 100,
      accountReference: 'TestRef',
      description: 'Test',
      idempotencyKey: 'order-abc-123',
    })

    expect(second.paymentId).toBe(first.paymentId)
    expect(second.checkoutRequestId).toBe(first.checkoutRequestId)
    expect(mockFetch2).not.toHaveBeenCalled() // No network call on idempotent re-request
  })
})
