/**
 * result-codes.test.ts
 *
 * Tests for every documented ResultCode and the package's handling of each one.
 *
 * ResultCode sources (all fetched during this session):
 *   https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
 *   https://tuma.co.ke/common-mpesa-daraja-api-error-codes-explanation-and-mitigation/
 *   https://woodev.co.ke/common-m-pesa-api-errors/
 *   https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
 */

import { describe, it, expect } from 'vitest'
import { resultCodeToStatus } from '../../src/callback.js'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import { processCallback } from '../../src/callback.js'
import {
  mockCallbackSuccess,
  mockCallbackFailure,
} from './helpers/mocks.js'

// ---------------------------------------------------------------------------
// resultCodeToStatus mapping
// ---------------------------------------------------------------------------

describe('resultCodeToStatus — confirmed ResultCodes', () => {
  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs + multiple independent developer guides
   * PRODUCTION IMPACT: ResultCode 0 must map to SUCCESS — anything else is a bug.
   */
  it('maps ResultCode 0 to SUCCESS', () => {
    expect(resultCodeToStatus(0)).toBe('SUCCESS')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 1 = insufficient balance
   * PRODUCTION IMPACT: must be marked FAILED and user shown appropriate message.
   */
  it('maps ResultCode 1 (insufficient balance) to FAILED', () => {
    expect(resultCodeToStatus(1)).toBe('FAILED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 1001 = subscriber lock (active USSD session)
   * PRODUCTION IMPACT: must be marked FAILED — user has another transaction in progress.
   */
  it('maps ResultCode 1001 (subscriber lock) to FAILED', () => {
    expect(resultCodeToStatus(1001)).toBe('FAILED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 1019 = transaction expired
   * PRODUCTION IMPACT: must be marked EXPIRED, not FAILED — different retry strategy needed.
   */
  it('maps ResultCode 1019 (transaction expired) to EXPIRED', () => {
    expect(resultCodeToStatus(1019)).toBe('EXPIRED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 1025 = issue with push request
   * PRODUCTION IMPACT: must be marked FAILED.
   */
  it('maps ResultCode 1025 (issue sending push) to FAILED', () => {
    expect(resultCodeToStatus(1025)).toBe('FAILED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * CONFIRMED BY: developer docs — ResultCode 1032 = user cancelled
   * PRODUCTION IMPACT: must be marked CANCELLED — should not be retried automatically.
   */
  it('maps ResultCode 1032 (user cancelled) to CANCELLED', () => {
    expect(resultCodeToStatus(1032)).toBe('CANCELLED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://tuma.co.ke/common-mpesa-daraja-api-error-codes-explanation-and-mitigation/
   * CONFIRMED BY: developer docs — ResultCode 1037 = DS timeout, user unreachable
   * PRODUCTION IMPACT: must be marked TIMEOUT — retry after network connectivity improves.
   */
  it('maps ResultCode 1037 (user unreachable / DS timeout) to TIMEOUT', () => {
    expect(resultCodeToStatus(1037)).toBe('TIMEOUT')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 2001 = invalid initiator info (wrong PIN)
   * PRODUCTION IMPACT: must be marked FAILED — user entered wrong PIN.
   */
  it('maps ResultCode 2001 (wrong PIN / invalid initiator) to FAILED', () => {
    expect(resultCodeToStatus(2001)).toBe('FAILED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * SOURCE: https://tuma.co.ke/common-mpesa-daraja-api-error-codes-explanation-and-mitigation/
   * CONFIRMED BY: developer docs — ResultCode 9999 = general push request error
   * PRODUCTION IMPACT: must be marked FAILED — also triggered by TransactionDesc > 182 chars.
   */
  it('maps ResultCode 9999 (general error / message too long) to FAILED', () => {
    expect(resultCodeToStatus(9999)).toBe('FAILED')
  })

  /**
   * SOURCE: package source — resultCodeToStatus has a default case that returns FAILED.
   * This covers any unknown ResultCode the API might return.
   * CONFIRMED BY: package source (callback.ts line 38)
   * PRODUCTION IMPACT: unknown codes must not be silently swallowed; FAILED is appropriate.
   */
  it('maps any unknown/undocumented ResultCode to FAILED (safe default)', () => {
    expect(resultCodeToStatus(99999)).toBe('FAILED')
    expect(resultCodeToStatus(-1)).toBe('FAILED')
    expect(resultCodeToStatus(500)).toBe('FAILED')
  })
})

// ---------------------------------------------------------------------------
// Full callback processing for each ResultCode
// ---------------------------------------------------------------------------

async function makePaymentRecord(checkoutRequestId: string) {
  const storage = new MemoryAdapter()
  const record = {
    id: 'payment-001',
    checkoutRequestId,
    merchantRequestId: '29115-34620561-1',
    phoneNumber: '254708374149',
    amount: 100,
    accountReference: 'TestRef',
    status: 'PENDING' as const,
    initiatedAt: new Date(),
  }
  await storage.createPayment(record)
  return { storage, record }
}

describe('callback processing — ResultCode outcomes', () => {
  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * CONFIRMED BY: developer docs — success callback has ResultCode: 0 (number) and CallbackMetadata.
   */
  it('processes a ResultCode 0 (success) callback and returns SUCCESS status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_191220191020363925')
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_191220191020363925',
      amount: 100,
      receipt: 'NLJ7RT61SV',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('SUCCESS')
    expect(result.isDuplicate).toBe(false)
    expect(result.receipt).toBe('NLJ7RT61SV')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 1032 callback has no CallbackMetadata.
   */
  it('processes a ResultCode 1032 (user cancelled) callback and returns CANCELLED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_cancel_001')
    const cb = mockCallbackFailure(1032, 'Request cancelled by user', {
      checkoutRequestId: 'ws_CO_cancel_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('CANCELLED')
    expect(result.isDuplicate).toBe(false)
    expect(result.receipt).toBeUndefined()

    // Verify failure is stored
    const payment = await storage.getPaymentByCheckoutId('ws_CO_cancel_001')
    expect(payment?.status).toBe('CANCELLED')
    expect(payment?.failureReason).toBe('Request cancelled by user')
    expect(payment?.resultCode).toBe(1032)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://tuma.co.ke/common-mpesa-daraja-api-error-codes-explanation-and-mitigation/
   * CONFIRMED BY: developer docs — ResultCode 1037 = DS timeout.
   */
  it('processes a ResultCode 1037 (DS timeout) callback and returns TIMEOUT status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_timeout_001')
    const cb = mockCallbackFailure(1037, '[STK DS timeout] Request timeout.', {
      checkoutRequestId: 'ws_CO_timeout_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('TIMEOUT')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 1 = insufficient balance.
   */
  it('processes a ResultCode 1 (insufficient balance) callback and returns FAILED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_funds_001')
    const cb = mockCallbackFailure(1, 'The balance is insufficient for the transaction.', {
      checkoutRequestId: 'ws_CO_funds_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('FAILED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 2001 = wrong PIN.
   */
  it('processes a ResultCode 2001 (wrong PIN) callback and returns FAILED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_pin_001')
    const cb = mockCallbackFailure(2001, 'Invalid initiator information.', {
      checkoutRequestId: 'ws_CO_pin_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('FAILED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 1019 = transaction expired.
   */
  it('processes a ResultCode 1019 (expired) callback and returns EXPIRED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_expired_001')
    const cb = mockCallbackFailure(1019, 'Transaction expired.', {
      checkoutRequestId: 'ws_CO_expired_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('EXPIRED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — ResultCode 9999 = general error.
   */
  it('processes a ResultCode 9999 (general error) callback and returns FAILED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_9999_001')
    const cb = mockCallbackFailure(9999, 'Unable to send push request.', {
      checkoutRequestId: 'ws_CO_9999_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('FAILED')
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — ResultCode 1001 = subscriber locked.
   */
  it('processes a ResultCode 1001 (subscriber lock) callback and returns FAILED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_1001_001')
    const cb = mockCallbackFailure(1001, 'Unable to lock subscriber, a previous transaction is in process.', {
      checkoutRequestId: 'ws_CO_1001_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('FAILED')
  })

  /**
   * SOURCE: package source (callback.ts) — ResultCode 17 is in the source but NOT
   * confirmed in any developer source fetched during this session.
   * CONFIRMED BY: package source only — resultCodeToStatus maps it to FAILED via default.
   *
   * UNVERIFIED: ResultCode 17 (transaction limit exceeded) — present in package source
   * but not confirmed from any developer document fetched during this session.
   * See UNVERIFIED_BEHAVIORS.md for details.
   */
  it.todo('maps ResultCode 17 (transaction limit exceeded) to correct status — needs source confirmation')
})

// ---------------------------------------------------------------------------
// ResultCode stored on failed payment
// ---------------------------------------------------------------------------

describe('callback processing — resultCode stored on payment record', () => {
  /**
   * SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
   * CONFIRMED BY: developer docs — resultCode must be stored for debugging and reconciliation.
   * PRODUCTION IMPACT: without stored resultCode, you cannot distinguish 1032 from 1037 in reports.
   */
  it('stores the raw resultCode on the payment record for audit purposes', async () => {
    const { storage } = await makePaymentRecord('ws_CO_audit_001')
    const cb = mockCallbackFailure(1037, '[STK DS timeout] Request timeout.', {
      checkoutRequestId: 'ws_CO_audit_001',
    })

    await processCallback(cb, storage)
    const payment = await storage.getPaymentByCheckoutId('ws_CO_audit_001')
    expect(payment?.resultCode).toBe(1037)
  })

  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * CONFIRMED BY: developer docs — raw callback body should be preserved for audit.
   * PRODUCTION IMPACT: without rawCallback, you cannot replay or debug disputed transactions.
   */
  it('stores the raw callback body on the payment record', async () => {
    const { storage } = await makePaymentRecord('ws_CO_rawcb_001')
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_rawcb_001',
      amount: 100,
    })

    await processCallback(cb, storage)
    const payment = await storage.getPaymentByCheckoutId('ws_CO_rawcb_001')
    expect(payment?.rawCallback).toBeDefined()
    expect(payment?.rawCallback).toMatchObject(cb)
  })
})
