/**
 * POST /api/mpesa/callback
 *
 * Receives STK Push callbacks from Safaricom's servers.
 *
 * Three rules that cannot be broken:
 *
 *   1. Always respond { ResultCode: 0 } with HTTP 200. Safaricom treats anything
 *      else as a failure and retries. Return 200 even if the payload is garbage.
 *
 *   2. Respond within 5 seconds. Send the response before doing any slow work.
 *      The onPaymentSettled handler (registered in lib/mpesa.ts) runs after the
 *      response is sent — it will not block Safaricom's acknowledgement window.
 *
 *   3. This endpoint must be publicly reachable. Exclude it from any auth
 *      middleware (NextAuth, Clerk, etc.) in your middleware.ts.
 *
 * Recommended: allowlist Safaricom's callback IPs at your WAF or CDN:
 *   196.201.214.200/28  196.201.214.216/29  196.201.214.232/30
 *   196.201.214.236/32  196.201.214.238/32  196.201.214.240/30
 *   196.201.214.244/32  196.201.214.246/32
 */

import { NextRequest, NextResponse } from 'next/server'
import { mpesa } from '@/lib/mpesa'

const ACK = NextResponse.json({ ResultCode: 0, ResultDesc: 'Success' })

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    // Return 200 even on a parse error. A non-200 triggers retries.
    console.error('[mpesa:callback] failed to parse body')
    return ACK
  }

  try {
    const result = await mpesa.processCallback(body)
    if (!result.isDuplicate) {
      console.log('[mpesa:callback]', result.paymentId, result.status)
    }
  } catch (err) {
    // Log and continue — never return non-200 to Safaricom.
    console.error('[mpesa:callback] processing error', err)
  }

  return ACK
}
