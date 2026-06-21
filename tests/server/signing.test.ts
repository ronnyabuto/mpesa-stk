import { describe, it, expect } from 'vitest'
import { signBody, verifySignature } from '../../src/server/signing.js'

// The relay signs every outbound delivery; the receiving app verifies it.
// Without this, "anyone who knows your URL can POST fake success payloads."
// These tests exercise the full attacker model, not just the happy path.

const SECRET = 'a'.repeat(64) // 32-byte hex secret, as generateSigningSecret() produces
const BODY = JSON.stringify({
  Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok' } },
})

describe('signBody / verifySignature — round trip', () => {
  it('a freshly signed body verifies with the same secret', () => {
    const sig = signBody(BODY, SECRET)
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifySignature(BODY, SECRET, sig)).toBe(true)
  })

  it('is deterministic — same body + secret produces the same signature', () => {
    expect(signBody(BODY, SECRET)).toBe(signBody(BODY, SECRET))
  })
})

describe('verifySignature — forgery and tampering are rejected', () => {
  it('rejects a body that was modified after signing (the core attack)', () => {
    const sig = signBody(BODY, SECRET)
    const tampered = JSON.stringify({
      Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok', Amount: 999999 } },
    })
    expect(verifySignature(tampered, SECRET, sig)).toBe(false)
  })

  it('rejects a signature made with a different secret (attacker does not know it)', () => {
    const attackerSig = signBody(BODY, 'b'.repeat(64))
    expect(verifySignature(BODY, SECRET, attackerSig)).toBe(false)
  })

  it('rejects a forged success payload with no/garbage signature', () => {
    const forged = JSON.stringify({
      Body: { stkCallback: { CheckoutRequestID: 'ws_CO_attack', ResultCode: 0, ResultDesc: 'Success' } },
    })
    expect(verifySignature(forged, SECRET, '')).toBe(false)
    expect(verifySignature(forged, SECRET, 'sha256=deadbeef')).toBe(false)
    expect(verifySignature(forged, SECRET, 'not-even-close')).toBe(false)
  })

  it('rejects a signature whose hex was bit-flipped (length matches, content differs)', () => {
    const sig = signBody(BODY, SECRET)
    const last = sig.slice(-1)
    const flipped = sig.slice(0, -1) + (last === '0' ? '1' : '0')
    expect(flipped).toHaveLength(sig.length)
    expect(verifySignature(BODY, SECRET, flipped)).toBe(false)
  })

  it('does not throw on a malformed signature of a different length (timingSafeEqual guard)', () => {
    // verifySignature must return false, not throw, when buffers differ in length.
    expect(() => verifySignature(BODY, SECRET, 'sha256=short')).not.toThrow()
    expect(verifySignature(BODY, SECRET, 'sha256=short')).toBe(false)
  })

  it('an empty-body signature does not validate a non-empty body', () => {
    const emptySig = signBody('', SECRET)
    expect(verifySignature(BODY, SECRET, emptySig)).toBe(false)
  })
})
