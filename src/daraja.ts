import type { MpesaConfig, DarajaQueryResponse } from './types.js'
import { getEATTimestamp, generatePassword, getBaseUrl, fetchAccessToken, fetchWithTimeout } from './initiate.js'

/**
 * Thrown when the Daraja STK Query endpoint rate-limits a request (HTTP 429).
 *
 * The endpoint sits behind an Apigee SpikeArrest policy — observed in the
 * sandbox (June 2026) as 5 requests / 60s, burst 1. Callers should back off and
 * retry rather than treating this as a hard failure: a 429 says nothing about
 * the transaction's state. `retryAfterMs` carries the server's `Retry-After`
 * hint when present.
 */
export class DarajaRateLimitError extends Error {
  readonly status = 429
  constructor(readonly retryAfterMs: number | undefined, detail: string) {
    super(`Daraja STK Query rate-limited (HTTP 429)${detail ? `: ${detail}` : ''}`)
    this.name = 'DarajaRateLimitError'
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}

export async function queryStkStatus(
  config: MpesaConfig,
  checkoutRequestId: string,
  timeoutMs = 75_000
): Promise<DarajaQueryResponse> {
  const timestamp = getEATTimestamp()
  const password = generatePassword(config.shortCode, config.passKey, timestamp)
  const accessToken = await fetchAccessToken(config, timeoutMs)

  const url = `${getBaseUrl(config.environment)}/mpesa/stkpushquery/v1/query`

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        BusinessShortCode: config.shortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
    },
    timeoutMs
  )

  // Daraja returns HTTP 200 for application-level errors (cancelled, wrong PIN, etc.)
  // and the result code is in the body. Only check res.ok for infrastructure failures
  // (401, 429, 503) whose bodies are not valid DarajaQueryResponse JSON.

  // 429 is special: it is retryable and says nothing about the transaction state.
  // Surface it as a typed error so callers can back off instead of skipping.
  if (res.status === 429) {
    const text = await res.text().catch(() => '')
    throw new DarajaRateLimitError(parseRetryAfterMs(res.headers.get('retry-after')), text)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Daraja STK Query responded with HTTP ${res.status}${text ? `: ${text}` : ''}`)
  }

  const data = await res.json() as DarajaQueryResponse
  return data
}
