import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Sign a request body with HMAC-SHA256.
 * Returns the signature in the format: sha256=<hex>
 *
 * Attach this as the X-Mpesa-Signature header on outbound delivery attempts
 * so your app can verify the webhook came from the relay and not an attacker
 * who discovered your endpoint URL.
 */
export function signBody(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Verify an inbound X-Mpesa-Signature against the raw request body.
 * Use this in your app to authenticate relay-delivered webhooks.
 *
 * Always use this over a plain string comparison — timingSafeEqual prevents
 * timing attacks where an attacker probes character-by-character.
 */
export function verifySignature(body: string, secret: string, signature: string): boolean {
  const expected = signBody(body, secret)
  try {
    // Both buffers must be the same length for timingSafeEqual
    if (expected.length !== signature.length) return false
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
  } catch {
    return false
  }
}
