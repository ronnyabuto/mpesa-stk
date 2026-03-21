/**
 * callback-edge-cases.test.ts
 *
 * Real production callback anomalies and edge cases.
 *
 * Sources:
 *   https://mpesa-nextjs-docs.vercel.app/handling-callback
 *   https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
 *   https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
 *   https://woodev.co.ke/common-m-pesa-api-errors/
 *   https://tuma.co.ke/common-mpesa-daraja-api-error-codes-explanation-and-mitigation/
 */

import { describe, it, expect } from 'vitest'
import { processCallback } from '../../src/callback.js'
import { validateCallbackStructure, validateCallbackAmount } from '../../src/validate.js'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import {
  mockCallbackSuccess,
  mockCallbackFailure,
  type CallbackSuccessShape,
} from './helpers/mocks.js'

async function makeStorage(checkoutRequestId: string, amount = 100) {
  const storage = new MemoryAdapter()
  await storage.createPayment({
    id: 'pay-001',
    checkoutRequestId,
    merchantRequestId: '29115-34620561-1',
    phoneNumber: '254708374149',
    amount,
    accountReference: 'TestRef',
    status: 'PENDING',
    initiatedAt: new Date(),
  })
  return storage
}

// ---------------------------------------------------------------------------
// Callback structure validation
// ---------------------------------------------------------------------------

describe('callback structure — what Safaricom actually sends', () => {
  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * CONFIRMED BY: developer docs — success callback always wraps stkCallback in Body.
   * PRODUCTION IMPACT: if your handler expects a flat body, all callbacks fail silently.
   */
  it('accepts a correctly structured success callback with Body.stkCallback wrapper', () => {
    const cb = mockCallbackSuccess({ checkoutRequestId: 'ws_CO_001', amount: 100 })
    expect(validateCallbackStructure(cb)).toBe(true)
  })

  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * CONFIRMED BY: developer docs — failure callback has NO CallbackMetadata.
   * PRODUCTION IMPACT: code that always reads CallbackMetadata will throw on failure callbacks.
   */
  it('accepts a correctly structured failure callback without CallbackMetadata', () => {
    const cb = mockCallbackFailure(1032, 'Request cancelled by user', {
      checkoutRequestId: 'ws_CO_002',
    })
    expect(validateCallbackStructure(cb)).toBe(true)
  })

  /**
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * CONFIRMED BY: developer docs — ResultCode in callbacks is a number, not a string.
   * PRODUCTION IMPACT: validateCallbackStructure checks typeof === 'number' for ResultCode.
   * A string ResultCode "1032" would fail validation and the callback would be discarded.
   */
  it('rejects a callback where ResultCode is a string (type mismatch)', () => {
    const cb = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_003',
          ResultCode: '1032', // string — WRONG type for callbacks
          ResultDesc: 'Request cancelled by user',
        },
      },
    }
    // The callback validator requires ResultCode to be a number
    expect(validateCallbackStructure(cb)).toBe(false)
  })

  /**
   * SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
   * CONFIRMED BY: developer docs — ResultCode must be a number in callback body.
   * PRODUCTION IMPACT: callback with missing required fields must not be silently accepted.
   */
  it('rejects a callback missing required fields', () => {
    expect(validateCallbackStructure(null)).toBe(false)
    expect(validateCallbackStructure({})).toBe(false)
    expect(validateCallbackStructure({ Body: {} })).toBe(false)
    expect(validateCallbackStructure({ Body: { stkCallback: {} } })).toBe(false)
    expect(validateCallbackStructure({
      Body: {
        stkCallback: {
          MerchantRequestID: '29115',
          CheckoutRequestID: 'ws_CO',
          // missing ResultCode and ResultDesc
        },
      },
    })).toBe(false)
  })

  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * CONFIRMED BY: developer docs — success callback MUST have CallbackMetadata.Item array.
   * PRODUCTION IMPACT: success callback without metadata cannot extract receipt number.
   */
  it('rejects a success callback (ResultCode 0) that is missing CallbackMetadata', () => {
    const cb = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_004',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          // Missing CallbackMetadata!
        },
      },
    }
    expect(validateCallbackStructure(cb)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Amount validation in callbacks
// ---------------------------------------------------------------------------

describe('callback Amount field — validation and tolerance', () => {
  /**
   * SOURCE: package source (validate.ts) — allows ±1 KES tolerance.
   * CONFIRMED BY: package design — "M-Pesa sometimes sends 1.0 for a 1 KES transaction".
   * PRODUCTION IMPACT: strict equality check would reject valid callbacks.
   */
  it('accepts callback Amount that matches exactly', () => {
    expect(validateCallbackAmount(100, 100)).toBe(true)
  })

  /**
   * SOURCE: package source (validate.ts lines 1-10).
   * CONFIRMED BY: package source — ±1 KES tolerance is explicitly documented.
   * PRODUCTION IMPACT: rejecting a callback with amount 100.0 when 100 was charged
   * would require manual intervention.
   */
  it('accepts callback Amount within ±1 KES tolerance (e.g. 100.0 vs 100)', () => {
    expect(validateCallbackAmount(100, 100.0)).toBe(true)
    expect(validateCallbackAmount(100, 100.5)).toBe(true)
    expect(validateCallbackAmount(100, 99.5)).toBe(true)
    expect(validateCallbackAmount(100, 101)).toBe(true)
    expect(validateCallbackAmount(100, 99)).toBe(true)
  })

  /**
   * SOURCE: package source (validate.ts).
   * CONFIRMED BY: package design — amounts >±1 must be flagged as mismatches.
   * PRODUCTION IMPACT: accepting large amount discrepancies is a financial fraud risk.
   */
  it('rejects callback Amount that differs by more than ±1 KES', () => {
    expect(validateCallbackAmount(100, 50)).toBe(false)
    expect(validateCallbackAmount(100, 200)).toBe(false)
    expect(validateCallbackAmount(1000, 999)).toBe(true)  // ±1 = ok
    expect(validateCallbackAmount(1000, 998)).toBe(false) // ±2 = rejected
  })

  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * CONFIRMED BY: developer docs — Amount in CallbackMetadata is a number type.
   * PRODUCTION IMPACT: if Amount is treated as string, arithmetic comparisons break.
   */
  it('throws an amount mismatch error when callback Amount exceeds tolerance', async () => {
    const storage = await makeStorage('ws_CO_amt_mismatch', 100)
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_amt_mismatch',
      amount: 50, // Significant mismatch — should not be accepted
    })

    await expect(processCallback(cb, storage)).rejects.toThrow(/amount mismatch/i)
  })
})

// ---------------------------------------------------------------------------
// Duplicate callback handling
// ---------------------------------------------------------------------------

describe('duplicate callback deduplication', () => {
  /**
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * CONFIRMED BY: developer report — Safaricom retries callbacks if endpoint is slow to respond.
   * "if a response delays, mpesa api assumes it as failed and retries"
   * PRODUCTION IMPACT: without deduplication, retry callbacks cause duplicate SUCCESS processing,
   * double credit to users, duplicate receipts, etc.
   */
  it('returns isDuplicate=true when the same success callback arrives twice', async () => {
    const storage = await makeStorage('ws_CO_dup_001')
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_dup_001',
      amount: 100,
      receipt: 'NLJ7RT61SV',
    })

    const first = await processCallback(cb, storage)
    expect(first.isDuplicate).toBe(false)
    expect(first.status).toBe('SUCCESS')

    const second = await processCallback(cb, storage)
    expect(second.isDuplicate).toBe(true)
    expect(second.status).toBe('SUCCESS')
    expect(second.receipt).toBe('NLJ7RT61SV')
  })

  /**
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * CONFIRMED BY: developer report — callbacks may be retried multiple times.
   * PRODUCTION IMPACT: failure callbacks also get retried — must be deduplicated.
   */
  it('returns isDuplicate=true when the same failure callback arrives twice', async () => {
    const storage = await makeStorage('ws_CO_dup_002')
    const cb = mockCallbackFailure(1032, 'Request cancelled by user', {
      checkoutRequestId: 'ws_CO_dup_002',
    })

    const first = await processCallback(cb, storage)
    expect(first.isDuplicate).toBe(false)
    expect(first.status).toBe('CANCELLED')

    const second = await processCallback(cb, storage)
    expect(second.isDuplicate).toBe(true)
    expect(second.status).toBe('CANCELLED')
  })

  /**
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * CONFIRMED BY: developer report — "implement your own retry logic on the application side"
   * PRODUCTION IMPACT: a success then failure callback sequence must not downgrade the status.
   */
  it('ignores a failure callback that arrives after a success callback for the same payment', async () => {
    const storage = await makeStorage('ws_CO_dup_003')
    const successCb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_dup_003',
      amount: 100,
    })
    const failureCb = mockCallbackFailure(1032, 'Request cancelled by user', {
      checkoutRequestId: 'ws_CO_dup_003',
    })

    await processCallback(successCb, storage)
    const second = await processCallback(failureCb, storage)

    expect(second.isDuplicate).toBe(true)
    // Status must remain SUCCESS — the failure arrived after success was recorded
    expect(second.status).toBe('SUCCESS')
  })

  /**
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * CONFIRMED BY: developer docs — "Since M-Pesa does not always retry failed callback
   * deliveries, you should use the Transaction Status Query API to verify outcomes."
   * PRODUCTION IMPACT: a callback for an unknown CheckoutRequestID must not crash the handler.
   */
  it('throws an error when a callback arrives for an unknown CheckoutRequestID', async () => {
    const storage = new MemoryAdapter()
    // No payment stored

    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_unknown_999',
      amount: 100,
    })

    await expect(processCallback(cb, storage)).rejects.toThrow(
      /No payment found for CheckoutRequestID/
    )
  })
})

// ---------------------------------------------------------------------------
// PhoneNumber in callback metadata
// ---------------------------------------------------------------------------

describe('PhoneNumber field in callback metadata', () => {
  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * SOURCE: Web search results confirming "PhoneNumber": 254727894083 (integer, no + prefix)
   * CONFIRMED BY: developer docs — PhoneNumber is returned as a 12-digit integer.
   * PRODUCTION IMPACT: code that tries to use callback PhoneNumber as a string will break.
   *
   * Note from package source (callback.ts line 109):
   * "PhoneNumber from callback is masked (e.g. 254708***430) or absent — DO NOT use it."
   * The package intentionally does NOT update phoneNumber from callback.
   */
  it('does not overwrite the stored phone number with the callback phone number', async () => {
    const storage = await makeStorage('ws_CO_phone_001')
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_phone_001',
      amount: 100,
      phoneNumber: 254708999999, // Different number in callback
    })

    await processCallback(cb, storage)
    const payment = await storage.getPaymentByCheckoutId('ws_CO_phone_001')
    // Original phone number must be preserved
    expect(payment?.phoneNumber).toBe('254708374149')
  })

  /**
   * SOURCE: package source (validate.ts comment, callback.ts comment)
   * CONFIRMED BY: package design — PhoneNumber is optional in CallbackMetadata.
   * PRODUCTION IMPACT: absent PhoneNumber (masked in 2026+) must not cause errors.
   */
  it('processes a success callback that has no PhoneNumber in CallbackMetadata', async () => {
    const storage = await makeStorage('ws_CO_noPhone_001')
    const cb: CallbackSuccessShape = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_noPhone_001',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 100 },
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'TransactionDate', Value: 20191219102115 },
              // No PhoneNumber item
            ],
          },
        },
      },
    }

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// TransactionDate in callback metadata
// ---------------------------------------------------------------------------

describe('TransactionDate field in callback metadata', () => {
  /**
   * SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
   * CONFIRMED BY: developer docs show TransactionDate as number format YYYYMMDDHHmmss
   * (e.g. 20191219102115)
   * PRODUCTION IMPACT: code expecting a Date object or ISO string will fail on number type.
   *
   * Note: mpesa-nextjs-docs shows TransactionDate as a string "YYYY-MM-DD HH:MM:SS".
   * This CONTRADICTS the bascil docs. The package stores it as-is (rawCallback) and
   * does not parse it — the safest approach given the inconsistency.
   */
  it('processes a success callback with TransactionDate as a 14-digit number', async () => {
    const storage = await makeStorage('ws_CO_txdate_001')
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_txdate_001',
      amount: 100,
      transactionDate: 20191219102115,
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('SUCCESS')
    // TransactionDate stored as part of rawCallback
    const payment = await storage.getPaymentByCheckoutId('ws_CO_txdate_001')
    expect(payment?.rawCallback).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Balance item in callback (sometimes present, sometimes absent)
// ---------------------------------------------------------------------------

describe('Balance item in callback metadata (optional)', () => {
  /**
   * SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
   * CONFIRMED BY: developer docs — Balance field is documented as present in some callbacks.
   * PRODUCTION IMPACT: code that requires Balance to be present will break on some callbacks.
   */
  it('processes a success callback that includes a Balance item without error', async () => {
    const storage = await makeStorage('ws_CO_balance_001')
    const cb: CallbackSuccessShape = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_balance_001',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 100 },
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'Balance', Value: 5000 }, // Optional balance field
              { Name: 'TransactionDate', Value: 20191219102115 },
              { Name: 'PhoneNumber', Value: 254708374149 },
            ],
          },
        },
      },
    }

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('SUCCESS')
  })
})
