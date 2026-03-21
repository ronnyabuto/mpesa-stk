/**
 * Shared Daraja API helpers used by poll.ts and reconcile.ts.
 * Single definition to prevent the two modules diverging.
 */

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

  // Daraja returns 200 even for many error states; parse body regardless
  const data = await res.json() as DarajaQueryResponse
  return data
}
