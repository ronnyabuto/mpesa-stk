import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mockTokenResponse,
  mockStkPushSuccess,
  mockStkPushError,
  makeTokenThenApiMock,
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
  it('uses sandbox base URL for sandbox environment', () => {
    expect(getBaseUrl('sandbox')).toBe('https://sandbox.safaricom.co.ke')
  })

  it('uses production base URL for production environment', () => {
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

  // Daraja's OAuth endpoint uses GET, not POST — wrong method returns 405
  it('calls OAuth token endpoint with GET method', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockTokenResponse()),
      text: () => Promise.resolve(''),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    await fetchAccessToken(SANDBOX_CONFIG)

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(options.method).toBe('GET')
  })

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

  // expires_in comes back from Daraja as a string "3600", not a number
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

    const token2 = await fetchAccessToken(SANDBOX_CONFIG)
    expect(token2).toBe('my-token')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('throws a descriptive error when OAuth endpoint returns non-200', async () => {
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

    const body = capturedBody!
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

  // For CustomerPayBillOnline, PartyB must equal BusinessShortCode (not the customer's phone)
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

  // ResponseCode "0" = accepted; any other value means the API rejected the request
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

  // Daraja sometimes returns error shapes with HTTP 200; check errorCode field too
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
    expect(mockFetch2).not.toHaveBeenCalled()
  })
})
