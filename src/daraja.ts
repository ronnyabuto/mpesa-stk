import type { MpesaConfig, DarajaQueryResponse } from './types.js'
import { getEATTimestamp, generatePassword, getBaseUrl, fetchAccessToken, fetchWithTimeout } from './initiate.js'

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
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Daraja STK Query responded with HTTP ${res.status}${text ? `: ${text}` : ''}`)
  }

  const data = await res.json() as DarajaQueryResponse
  return data
}
