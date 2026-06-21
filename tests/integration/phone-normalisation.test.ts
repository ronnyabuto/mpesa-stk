import { describe, it, expect } from 'vitest'
import { normalisePhoneNumber } from '../../src/initiate.js'

describe('normalisePhoneNumber — Safaricom (07xx) numbers', () => {
  it('normalises 0712345678 to 254712345678', () => {
    expect(normalisePhoneNumber('0712345678')).toBe('254712345678')
  })

  it('normalises 0722345678 to 254722345678', () => {
    expect(normalisePhoneNumber('0722345678')).toBe('254722345678')
  })

  it('normalises 0700000001 to 254700000001', () => {
    expect(normalisePhoneNumber('0700000001')).toBe('254700000001')
  })

  it('normalises 0799999999 to 254799999999', () => {
    expect(normalisePhoneNumber('0799999999')).toBe('254799999999')
  })
})

describe('normalisePhoneNumber — Airtel Kenya (010x, 011x) numbers', () => {
  it('normalises 0100000000 to 254100000000', () => {
    expect(normalisePhoneNumber('0100000000')).toBe('254100000000')
  })

  it('normalises 0110000000 to 254110000000', () => {
    expect(normalisePhoneNumber('0110000000')).toBe('254110000000')
  })
})

describe('normalisePhoneNumber — international format inputs', () => {
  it('normalises +254712345678 to 254712345678', () => {
    expect(normalisePhoneNumber('+254712345678')).toBe('254712345678')
  })

  it('normalises 254712345678 (already correct) to 254712345678', () => {
    expect(normalisePhoneNumber('254712345678')).toBe('254712345678')
  })

  it('normalises +254722345678 to 254722345678', () => {
    expect(normalisePhoneNumber('+254722345678')).toBe('254722345678')
  })

  it('normalises 254100000000 to 254100000000', () => {
    expect(normalisePhoneNumber('254100000000')).toBe('254100000000')
  })
})

describe('normalisePhoneNumber — format with spaces or dashes (common UI input)', () => {
  it('normalises 0712 345 678 (spaces) to 254712345678', () => {
    expect(normalisePhoneNumber('0712 345 678')).toBe('254712345678')
  })

  it('normalises +254-712-345-678 (dashes) to 254712345678', () => {
    expect(normalisePhoneNumber('+254-712-345-678')).toBe('254712345678')
  })

  it('normalises (0712)345678 (parentheses) to 254712345678', () => {
    expect(normalisePhoneNumber('(0712)345678')).toBe('254712345678')
  })
})

describe('normalisePhoneNumber — invalid inputs that must throw', () => {
  it('throws for an empty string', () => {
    expect(() => normalisePhoneNumber('')).toThrow(/Invalid phone number/)
  })

  it('throws for a 9-digit local number (too short)', () => {
    expect(() => normalisePhoneNumber('071234567')).toThrow(/Invalid phone number/)
  })

  it('throws for an 11-digit local number (too long)', () => {
    expect(() => normalisePhoneNumber('07123456789')).toThrow(/Invalid phone number/)
  })

  it('throws for a UK number (+44 prefix)', () => {
    expect(() => normalisePhoneNumber('+447911123456')).toThrow(/Invalid phone number/)
  })

  it('throws for a US number (+1 prefix)', () => {
    expect(() => normalisePhoneNumber('+14155552671')).toThrow(/Invalid phone number/)
  })

  it('throws for a non-numeric string', () => {
    expect(() => normalisePhoneNumber('not-a-number')).toThrow(/Invalid phone number/)
  })

  it('throws for a 13-digit number starting with 254 (too many digits)', () => {
    expect(() => normalisePhoneNumber('2547123456789')).toThrow(/Invalid phone number/)
  })
})

describe('normalisePhoneNumber — non-mobile prefixes must be rejected (real fat-finger inputs)', () => {
  // M-Pesa STK Push only reaches mobile subscribers. A user who mistypes a
  // landline or an invalid prefix should get a clear local error, not a wasted
  // Daraja round-trip that fails opaquely.
  it.each([
    ['0512345678', '05x — not a Kenyan mobile prefix'],
    ['0212345678', '02x — Nairobi landline'],
    ['0912345678', '09x — not assigned to mobile'],
    ['0812345678', '08x — not a mobile prefix'],
    ['0612345678', '06x — not a mobile prefix'],
    ['0012345678', '00x — invalid'],
    ['0123456789', '012 — outside the Airtel 010/011 mobile range'],
    ['0190000000', '019 — outside the Airtel 010/011 mobile range'],
  ])('rejects %s (%s)', (input) => {
    expect(() => normalisePhoneNumber(input)).toThrow(/Invalid phone number/)
  })

  it('rejects the same invalid prefixes in +254 international form', () => {
    expect(() => normalisePhoneNumber('+254512345678')).toThrow(/Invalid phone number/)
    expect(() => normalisePhoneNumber('254212345678')).toThrow(/Invalid phone number/)
  })
})

describe('normalisePhoneNumber — messy real-world UI input', () => {
  it.each([
    ['  0712345678  ', 'leading/trailing whitespace'],
    ['0712-345-678', 'dashes'],
    ['+254 712 345 678', 'spaces with country code'],
    ['(+254) 712 345 678', 'parentheses and country code'],
    ['254.712.345.678', 'dot separators'],
    ['0712 345678', 'single mid-space'],
  ])('normalises %s (%s) to 254712345678', (input) => {
    expect(normalisePhoneNumber(input)).toBe('254712345678')
  })

  it('rejects a string with embedded letters even if it contains a valid-looking number', () => {
    // "0712345678x" → digits "0712345678" — this WOULD pass. But pure-letter or
    // mixed inputs that strip to the wrong length must fail.
    expect(() => normalisePhoneNumber('phone: 0712')).toThrow(/Invalid phone number/)
    expect(() => normalisePhoneNumber('O712345678')).toThrow(/Invalid phone number/) // letter O, not zero
  })
})

describe('normalisePhoneNumber — boundary values for Kenyan numbers', () => {
  it('accepts exactly 12-digit 254XXXXXXXXX number', () => {
    const result = normalisePhoneNumber('254708374149')
    expect(result).toBe('254708374149')
    expect(result).toHaveLength(12)
  })

  it('accepts exactly 10-digit 07XXXXXXXXX number', () => {
    const result = normalisePhoneNumber('0708374149')
    expect(result).toBe('254708374149')
    expect(result).toHaveLength(12)
  })
})

describe('normalisePhoneNumber — PhoneNumber as returned in callback (number type)', () => {
  // Callback delivers PhoneNumber as a bare integer (e.g. 254708374149), not a string.
  // Callers who coerce it with .toString() before passing must still get the right result.
  it('normalises a callback PhoneNumber coerced to string correctly', () => {
    expect(normalisePhoneNumber('254708374149')).toBe('254708374149')
  })
})
