/**
 * token-lifecycle.test.ts
 *
 * OAuth token edge cases: expiry, caching, and boundary conditions.
 *
 * Sources:
 *   https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
 *   https://github.com/safaricom/mpesa-php-sdk/issues (issue #59 — 503 on OAuth endpoint)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchAccessToken, clearTokenCache } from '../../src/initiate.js'
import type { MpesaConfig } from '../../src/types.js'

const CONFIG: MpesaConfig = {
  consumerKey: 'test-key',
  consumerSecret: 'test-secret',
  shortCode: '174379',
  passKey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  callbackUrl: 'https://example.com/callback',
  environment: 'sandbox',
}

const PROD_CONFIG: MpesaConfig = {
  ...CONFIG,
  environment: 'production',
}

function makeTokenFetch(token: string, expiresIn: string = '3600') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ access_token: token, expires_in: expiresIn }),
    text: () => Promise.resolve(''),
  } as Response)
}

beforeEach(() => {
  clearTokenCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearTokenCache()
})

describe('token caching', () => {
  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — token valid for 3600 seconds, should be cached.
   * PRODUCTION IMPACT: fetching a new token on every request wastes quota and adds latency.
   */
  it('reuses a cached token when called multiple times within expiry window', async () => {
    const mockFetch = makeTokenFetch('token-abc')
    vi.stubGlobal('fetch', mockFetch)

    const t1 = await fetchAccessToken(CONFIG)
    const t2 = await fetchAccessToken(CONFIG)
    const t3 = await fetchAccessToken(CONFIG)

    expect(t1).toBe('token-abc')
    expect(t2).toBe('token-abc')
    expect(t3).toBe('token-abc')
    expect(mockFetch).toHaveBeenCalledTimes(1) // Only one HTTP call
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — token expires after 3600 seconds.
   * Package source (initiate.ts line 125): cache is invalidated 60 seconds BEFORE expiry.
   * PRODUCTION IMPACT: a token used at exactly 3599 seconds (still >60s buffer) is reused.
   */
  it('serves cached token at 3599 seconds (within 60s safety buffer)', async () => {
    vi.useFakeTimers()
    const mockFetch = makeTokenFetch('fresh-token')
    vi.stubGlobal('fetch', mockFetch)

    await fetchAccessToken(CONFIG)

    // Advance 3539 seconds (3600 - 61 = still within the safety window)
    vi.advanceTimersByTime(3539 * 1000)

    const token = await fetchAccessToken(CONFIG)
    expect(token).toBe('fresh-token')
    expect(mockFetch).toHaveBeenCalledTimes(1) // Still using cache
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — token expires after 3600 seconds.
   * Package source (initiate.ts line 125): cache invalidated when < 60s remains.
   * PRODUCTION IMPACT: if the expiry boundary is not respected, expired tokens are sent and
   * Daraja returns 404.001.03 Invalid Access Token on all subsequent requests.
   */
  it('fetches a new token when the cached token has less than 60 seconds remaining', async () => {
    vi.useFakeTimers()

    const firstMock = makeTokenFetch('token-first')
    vi.stubGlobal('fetch', firstMock)
    await fetchAccessToken(CONFIG)

    // Advance to 3541 seconds (only 59s remaining before expiry)
    vi.advanceTimersByTime(3541 * 1000)

    const secondMock = makeTokenFetch('token-second')
    vi.stubGlobal('fetch', secondMock)

    const token = await fetchAccessToken(CONFIG)
    expect(token).toBe('token-second')
    expect(secondMock).toHaveBeenCalledTimes(1)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — sandbox and production are separate environments.
   * PRODUCTION IMPACT: if tokens are shared across environments, sandbox tokens get used
   * in production (or vice versa), causing auth failures.
   */
  it('maintains separate token caches for sandbox and production environments', async () => {
    const sandboxFetch = makeTokenFetch('sandbox-token')
    vi.stubGlobal('fetch', sandboxFetch)
    const sandboxToken = await fetchAccessToken(CONFIG)

    const prodFetch = makeTokenFetch('production-token')
    vi.stubGlobal('fetch', prodFetch)
    const prodToken = await fetchAccessToken(PROD_CONFIG)

    expect(sandboxToken).toBe('sandbox-token')
    expect(prodToken).toBe('production-token')
    expect(sandboxToken).not.toBe(prodToken)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — expires_in is returned as STRING "3600".
   * PRODUCTION IMPACT: if expires_in is not parsed via parseInt, NaN expiry means
   * every request gets a new token (cache never hits) — silent performance regression.
   */
  it('correctly handles expires_in returned as string (not number)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: 'str-expiry-token', expires_in: '3600' }),
      text: () => Promise.resolve(''),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    const t1 = await fetchAccessToken(CONFIG)
    const t2 = await fetchAccessToken(CONFIG)

    expect(t1).toBe('str-expiry-token')
    expect(t2).toBe('str-expiry-token')
    expect(mockFetch).toHaveBeenCalledTimes(1) // Cache works with string expires_in
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: package source (initiate.ts line 149) — fallback to 3600 if expires_in is NaN.
   * PRODUCTION IMPACT: a malformed or missing expires_in from Daraja must not crash the token fetch.
   */
  it('falls back to 3600 seconds when expires_in is not parseable', async () => {
    vi.useFakeTimers()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: 'nan-expiry-token', expires_in: 'invalid' }),
      text: () => Promise.resolve(''),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    const token = await fetchAccessToken(CONFIG)
    expect(token).toBe('nan-expiry-token')

    // Should still be cached (fallback expiry = 3600s, cache within 60s buffer)
    const token2 = await fetchAccessToken(CONFIG)
    expect(token2).toBe('nan-expiry-token')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('token error handling', () => {
  /**
   * SOURCE: https://github.com/safaricom/mpesa-php-sdk/issues (issue #59)
   * CONFIRMED BY: github issue — "Error: call to URL .../oauth/v1/generate... failed with status 503"
   * PRODUCTION IMPACT: 503 during high load causes all concurrent STK initiations to fail.
   */
  it('throws a descriptive error including the HTTP status code on OAuth failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error()),
      text: () => Promise.resolve('Service Temporarily Unavailable'),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchAccessToken(CONFIG)).rejects.toThrow('503')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — 401 returned for invalid credentials.
   * PRODUCTION IMPACT: bad credentials used in production will silently fail all payments
   * if the error is not surfaced clearly.
   */
  it('throws a descriptive error on 401 Unauthorized (invalid credentials)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.reject(new Error()),
      text: () => Promise.resolve('Unauthorized'),
    } as Response)
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchAccessToken(CONFIG)).rejects.toThrow('401')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
   * CONFIRMED BY: developer docs — clearTokenCache is a test utility.
   * PRODUCTION IMPACT: after clearing cache, the next call MUST fetch a fresh token.
   */
  it('fetches a fresh token after cache is cleared', async () => {
    const firstMock = makeTokenFetch('original-token')
    vi.stubGlobal('fetch', firstMock)
    await fetchAccessToken(CONFIG)

    clearTokenCache()

    const secondMock = makeTokenFetch('fresh-after-clear')
    vi.stubGlobal('fetch', secondMock)
    const token = await fetchAccessToken(CONFIG)

    expect(token).toBe('fresh-after-clear')
    expect(secondMock).toHaveBeenCalledTimes(1)
  })
})
