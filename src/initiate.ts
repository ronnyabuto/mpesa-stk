import type {
  MpesaConfig,
  InitiatePaymentParams,
  DarajaStkPushRequest,
  DarajaStkPushSuccess,
  DarajaStkPushError,
  Logger,
} from './types.js'

// ---------------------------------------------------------------------------
// Phone number normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise any of: 07xxxxxxxx, 01xxxxxxxx, +2547xxxxxxxx, +2541xxxxxxxx,
 * 2547xxxxxxxx, 2541xxxxxxxx → 254xxxxxxxxx
 *
 * Covers Safaricom (07x), Airtel Kenya (010x, 011x), and Telkom Kenya (077x)
 * prefixes as well as their international equivalents.
 *
 * Throws on unrecognised format.
 */
export function normalisePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')

  // Local format (10 digits, leading 0): covers Safaricom 07x, Airtel 010x/011x,
  // Telkom/T-Kash 077x — any Kenyan number starting with 0 followed by 9 more digits.
  if (/^0\d{9}$/.test(digits)) {
    return '254' + digits.slice(1)
  }

  // International format (12 digits): 254 + 9-digit subscriber number.
  // +254 already stripped of the plus sign by replace(/\D/g,'') above.
  if (/^254\d{9}$/.test(digits)) {
    return digits
  }

  throw new Error(
    `Invalid phone number: "${raw}". ` +
    'Expected formats: 07xxxxxxxx, 01xxxxxxxx, +2547xxxxxxxx, +2541xxxxxxxx, ' +
    '2547xxxxxxxx, 2541xxxxxxxx, or any Kenyan mobile number in local or international format'
  )
}

// ---------------------------------------------------------------------------
// Timestamp — EAT (UTC+3) in YYYYMMDDHHmmss format
// ---------------------------------------------------------------------------

export function getEATTimestamp(date: Date = new Date()): string {
  // Offset by +3 hours
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000)
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')

  return (
    eat.getUTCFullYear().toString() +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  )
}

// ---------------------------------------------------------------------------
// Password generation
// ---------------------------------------------------------------------------

/**
 * base64(shortCode + passKey + timestamp)
 */
export function generatePassword(
  shortCode: string,
  passKey: string,
  timestamp: string
): string {
  return Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64')
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

/**
 * Wraps fetch with an AbortController-based timeout.
 * Uses config.timeoutMs (default 75 000 ms).
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  )
}

// ---------------------------------------------------------------------------
// Daraja base URL
// ---------------------------------------------------------------------------

export function getBaseUrl(environment: MpesaConfig['environment']): string {
  return environment === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke'
}

// ---------------------------------------------------------------------------
// Access token with in-process cache
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string
  /** Unix epoch milliseconds at which the token expires */
  expiresAtMs: number
}

// Keyed by environment so sandbox and production tokens don't collide
const tokenCacheByEnv = new Map<string, TokenCache>()

/** Flush the token cache — used in tests that stub `fetch`. */
export function clearTokenCache(): void {
  tokenCacheByEnv.clear()
}

/**
 * Fetch an OAuth access token, reusing a cached one if it has more than
 * 60 seconds of remaining lifetime.
 *
 * NOTE: This cache is in-process. In a serverless environment each function
 * invocation is a separate process and the cache is empty on every cold start.
 * Under sustained load a single long-running process will reuse the token
 * effectively; serverless deployments will re-fetch on each cold start.
 *
 * The 60-second buffer before the Daraja-advertised expiry (3600s) ensures we
 * never send a token that is on the exact expiry boundary.
 */
export async function fetchAccessToken(config: MpesaConfig, timeoutMs = 75_000): Promise<string> {
  const cacheKey = `${config.environment}:${config.consumerKey}`
  const cached = tokenCacheByEnv.get(cacheKey)
  const nowMs = Date.now()

  // Serve from cache if we have at least 60 seconds left
  if (cached && cached.expiresAtMs - nowMs > 60_000) {
    return cached.token
  }

  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`
  ).toString('base64')

  const url = `${getBaseUrl(config.environment)}/oauth/v1/generate?grant_type=client_credentials`

  const res = await fetchWithTimeout(
    url,
    { method: 'GET', headers: { Authorization: `Basic ${credentials}` } },
    timeoutMs
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to fetch access token (${res.status}): ${text}`)
  }

  const data = await res.json() as { access_token: string; expires_in: string }

  // expires_in is in seconds; store as absolute epoch ms
  const expiresInSec = parseInt(data.expires_in, 10)
  const expiresAtMs = nowMs + (isNaN(expiresInSec) ? 3600 : expiresInSec) * 1000

  tokenCacheByEnv.set(cacheKey, { token: data.access_token, expiresAtMs })

  return data.access_token
}

// ---------------------------------------------------------------------------
// STK Push initiation
// ---------------------------------------------------------------------------

export interface StkPushResult {
  merchantRequestId: string
  checkoutRequestId: string
}

export async function initiateStkPush(
  config: MpesaConfig,
  params: InitiatePaymentParams & { normalisedPhone: string },
  logger?: Logger,
  timeoutMs = 75_000
): Promise<StkPushResult> {
  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new Error(
      `Amount must be a positive integer. Received: ${params.amount}. ` +
      'M-Pesa does not support fractional amounts — round before calling initiatePayment.'
    )
  }

  const timestamp = getEATTimestamp()
  const password = generatePassword(config.shortCode, config.passKey, timestamp)
  const accessToken = await fetchAccessToken(config, timeoutMs)

  const body: DarajaStkPushRequest = {
    BusinessShortCode: config.shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: params.amount,
    PartyA: params.normalisedPhone,
    PartyB: config.shortCode,
    PhoneNumber: params.normalisedPhone,
    CallBackURL: config.callbackUrl,
    AccountReference: params.accountReference,
    TransactionDesc: params.description,
  }

  const url = `${getBaseUrl(config.environment)}/mpesa/stkpush/v1/processrequest`

  logger?.info('Initiating STK Push', {
    amount: params.amount,
    accountReference: params.accountReference,
  })

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  )

  const data = await res.json() as DarajaStkPushSuccess | DarajaStkPushError

  if (!res.ok || 'errorCode' in data) {
    const err = data as DarajaStkPushError
    throw new Error(
      `STK Push failed [${err.errorCode ?? res.status}]: ${err.errorMessage ?? 'Unknown error'}`
    )
  }

  const success = data as DarajaStkPushSuccess

  if (success.ResponseCode !== '0') {
    throw new Error(
      `STK Push rejected: ${success.ResponseDescription} (ResponseCode: ${success.ResponseCode})`
    )
  }

  logger?.info('STK Push accepted', {
    checkoutRequestId: success.CheckoutRequestID,
    merchantRequestId: success.MerchantRequestID,
  })

  return {
    merchantRequestId: success.MerchantRequestID,
    checkoutRequestId: success.CheckoutRequestID,
  }
}
