/**
 * phone-normalisation.test.ts
 *
 * Real Kenyan phone number formats and normalisation edge cases.
 *
 * Sources:
 *   https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
 *   Web search results confirming PhoneNumber must be in 254XXXXXXXXX format
 */

import { describe, it, expect } from 'vitest'
import { normalisePhoneNumber } from '../../src/initiate.js'

describe('normalisePhoneNumber — Safaricom (07xx) numbers', () => {
  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — phone numbers must use 254 country code format.
   * PRODUCTION IMPACT: sending 07xxxxxxxx without normalisation causes API rejection.
   */
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
  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: package source (initiate.ts) — covers Airtel Kenya 010x/011x prefixes.
   * PRODUCTION IMPACT: Airtel numbers used in M-Pesa STK Push are valid.
   */
  it('normalises 0100000000 to 254100000000', () => {
    expect(normalisePhoneNumber('0100000000')).toBe('254100000000')
  })

  it('normalises 0110000000 to 254110000000', () => {
    expect(normalisePhoneNumber('0110000000')).toBe('254110000000')
  })
})

describe('normalisePhoneNumber — international format inputs', () => {
  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — 254XXXXXXXXX is the required format.
   * PRODUCTION IMPACT: passing +2547xx (common in UI inputs) must be handled without throwing.
   */
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
  /**
   * SOURCE: package source (initiate.ts line 24) — strips non-digit characters first.
   * CONFIRMED BY: package design — normalisation strips \D characters before validation.
   * PRODUCTION IMPACT: phone numbers from forms often include spaces or dashes.
   */
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
  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — invalid phone numbers cause API rejection.
   * PRODUCTION IMPACT: invalid numbers must be caught early (before API call) with clear errors.
   */
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

describe('normalisePhoneNumber — boundary values for Kenyan numbers', () => {
  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — 254 followed by exactly 9 digits = valid.
   * PRODUCTION IMPACT: accepting invalid-length numbers can cause cryptic API errors.
   */
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
  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * Web search: "PhoneNumber": 254727894083 in callback (integer, no + prefix, 12 digits).
   * CONFIRMED BY: developer docs — PhoneNumber in callback is a number like 254708374149.
   * PRODUCTION IMPACT: callback PhoneNumber is a number but normalisePhoneNumber expects string.
   * If you call normalisePhoneNumber(callbackPhoneNumber.toString()), it must work.
   */
  it('normalises a callback PhoneNumber (integer as string) correctly', () => {
    // Callback delivers PhoneNumber as number 254708374149
    // When converted to string for normalisation:
    expect(normalisePhoneNumber('254708374149')).toBe('254708374149')
  })
})
