import { describe, it, expect } from 'vitest'
import { validateCallbackAmount } from '../src/validate.js'

// ---------------------------------------------------------------------------
// validateCallbackAmount — ±1 KES tolerance boundary
// ---------------------------------------------------------------------------

describe('validateCallbackAmount', () => {
  it('exact match — passes', () => {
    expect(validateCallbackAmount(100, 100)).toBe(true)
  })

  it('received exactly 1 KES more — passes (boundary)', () => {
    expect(validateCallbackAmount(100, 101)).toBe(true)
  })

  it('received exactly 1 KES less — passes (boundary)', () => {
    expect(validateCallbackAmount(100, 99)).toBe(true)
  })

  it('received 0.5 KES more — passes (within tolerance)', () => {
    expect(validateCallbackAmount(100, 100.5)).toBe(true)
  })

  it('expected 100, received 101.5 — fails (exceeds tolerance)', () => {
    expect(validateCallbackAmount(100, 101.5)).toBe(false)
  })

  it('expected 100, received 98.9 — fails (exceeds tolerance)', () => {
    expect(validateCallbackAmount(100, 98.9)).toBe(false)
  })

  it('expected 100, received 999 — fails (large mismatch)', () => {
    expect(validateCallbackAmount(100, 999)).toBe(false)
  })

  it('expected 1, received 1.0 — passes (float equality of integers)', () => {
    expect(validateCallbackAmount(1, 1.0)).toBe(true)
  })

  it('expected 500, received 501 — passes (boundary at higher amount)', () => {
    expect(validateCallbackAmount(500, 501)).toBe(true)
  })

  it('expected 500, received 501.1 — fails (just over boundary)', () => {
    expect(validateCallbackAmount(500, 501.1)).toBe(false)
  })
})
