import type { MpesaCallbackBody } from './types.js'

/**
 * Allow ±1 KES tolerance.
 * M-Pesa sometimes sends 1.0 for a 1 KES transaction while your DB stores 1.
 * This also guards against minor floating-point drift.
 */
export function validateCallbackAmount(expected: number, received: number): boolean {
  return Math.abs(expected - received) <= 1
}

/**
 * Type guard that verifies the raw callback body has the required structure.
 * PhoneNumber in CallbackMetadata is intentionally NOT required — Safaricom
 * masks or omits it in 2026+.
 */
export function validateCallbackStructure(body: unknown): body is MpesaCallbackBody {
  if (typeof body !== 'object' || body === null) return false

  const root = body as Record<string, unknown>
  if (typeof root['Body'] !== 'object' || root['Body'] === null) return false

  const bodyObj = root['Body'] as Record<string, unknown>
  if (typeof bodyObj['stkCallback'] !== 'object' || bodyObj['stkCallback'] === null) return false

  const cb = bodyObj['stkCallback'] as Record<string, unknown>
  if (typeof cb['MerchantRequestID'] !== 'string') return false
  if (typeof cb['CheckoutRequestID'] !== 'string') return false
  if (typeof cb['ResultCode'] !== 'number') return false
  if (typeof cb['ResultDesc'] !== 'string') return false

  // Success callbacks must have CallbackMetadata
  if (cb['ResultCode'] === 0) {
    if (typeof cb['CallbackMetadata'] !== 'object' || cb['CallbackMetadata'] === null) return false
    const meta = cb['CallbackMetadata'] as Record<string, unknown>
    if (!Array.isArray(meta['Item'])) return false
  }

  return true
}

/**
 * Extract a named item value from the callback metadata Item array.
 * Returns undefined if the item is absent (e.g. PhoneNumber in 2026).
 */
export function extractMetadataValue(
  items: Array<{ Name: string; Value?: string | number }>,
  name: string
): string | number | undefined {
  const item = items.find((i) => i.Name === name)
  return item?.Value
}
