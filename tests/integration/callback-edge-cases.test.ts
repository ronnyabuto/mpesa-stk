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

describe('callback structure — what Safaricom actually sends', () => {
  it('accepts a correctly structured success callback with Body.stkCallback wrapper', () => {
    const cb = mockCallbackSuccess({ checkoutRequestId: 'ws_CO_001', amount: 100 })
    expect(validateCallbackStructure(cb)).toBe(true)
  })

  // Failure callbacks have no CallbackMetadata — code that always reads it will throw
  it('accepts a correctly structured failure callback without CallbackMetadata', () => {
    const cb = mockCallbackFailure(1032, 'Request cancelled by user', {
      checkoutRequestId: 'ws_CO_002',
    })
    expect(validateCallbackStructure(cb)).toBe(true)
  })

  // ResultCode in callbacks is a number; a string "1032" would fail validation
  it('rejects a callback where ResultCode is a string (type mismatch)', () => {
    const cb = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_003',
          ResultCode: '1032',
          ResultDesc: 'Request cancelled by user',
        },
      },
    }
    expect(validateCallbackStructure(cb)).toBe(false)
  })

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
        },
      },
    })).toBe(false)
  })

  it('rejects a success callback (ResultCode 0) that is missing CallbackMetadata', () => {
    const cb = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_004',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
        },
      },
    }
    expect(validateCallbackStructure(cb)).toBe(false)
  })
})

describe('callback Amount field — validation and tolerance', () => {
  it('accepts callback Amount that matches exactly', () => {
    expect(validateCallbackAmount(100, 100)).toBe(true)
  })

  it('accepts callback Amount within ±1 KES tolerance (e.g. 100.0 vs 100)', () => {
    expect(validateCallbackAmount(100, 100.0)).toBe(true)
    expect(validateCallbackAmount(100, 100.5)).toBe(true)
    expect(validateCallbackAmount(100, 99.5)).toBe(true)
    expect(validateCallbackAmount(100, 101)).toBe(true)
    expect(validateCallbackAmount(100, 99)).toBe(true)
  })

  it('rejects callback Amount that differs by more than ±1 KES', () => {
    expect(validateCallbackAmount(100, 50)).toBe(false)
    expect(validateCallbackAmount(100, 200)).toBe(false)
    expect(validateCallbackAmount(1000, 999)).toBe(true)
    expect(validateCallbackAmount(1000, 998)).toBe(false)
  })

  it('throws an amount mismatch error when callback Amount exceeds tolerance', async () => {
    const storage = await makeStorage('ws_CO_amt_mismatch', 100)
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_amt_mismatch',
      amount: 50,
    })

    await expect(processCallback(cb, storage)).rejects.toThrow(/amount mismatch/i)
  })
})

describe('duplicate callback deduplication', () => {
  // Safaricom retries callbacks if your endpoint is slow to respond —
  // without deduplication, retries cause double-crediting
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

  // A late failure callback must not downgrade a previously recorded success
  it('ignores a failure callback that arrives after a success callback for the same payment', async () => {
    const storage = await makeStorage('ws_CO_dup_003')
    const successCb = mockCallbackSuccess({ checkoutRequestId: 'ws_CO_dup_003', amount: 100 })
    const failureCb = mockCallbackFailure(1032, 'Request cancelled by user', {
      checkoutRequestId: 'ws_CO_dup_003',
    })

    await processCallback(successCb, storage)
    const second = await processCallback(failureCb, storage)

    expect(second.isDuplicate).toBe(true)
    expect(second.status).toBe('SUCCESS')
  })

  it('throws an error when a callback arrives for an unknown CheckoutRequestID', async () => {
    const storage = new MemoryAdapter()
    const cb = mockCallbackSuccess({ checkoutRequestId: 'ws_CO_unknown_999', amount: 100 })

    await expect(processCallback(cb, storage)).rejects.toThrow(
      /No payment found for CheckoutRequestID/
    )
  })
})

describe('PhoneNumber field in callback metadata', () => {
  // Safaricom masks PhoneNumber in 2026+ (e.g. 254708***430) or omits it entirely.
  // We never update phoneNumber from the callback — the original value is preserved.
  it('does not overwrite the stored phone number with the callback phone number', async () => {
    const storage = await makeStorage('ws_CO_phone_001')
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_phone_001',
      amount: 100,
      phoneNumber: 254708999999,
    })

    await processCallback(cb, storage)
    const payment = await storage.getPaymentByCheckoutId('ws_CO_phone_001')
    expect(payment?.phoneNumber).toBe('254708374149')
  })

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
            ],
          },
        },
      },
    }

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('SUCCESS')
  })
})

describe('TransactionDate field in callback metadata', () => {
  // TransactionDate arrives as a 14-digit integer (YYYYMMDDHHmmss), not a Date or ISO string.
  // We store it as-is inside rawCallback rather than parsing it.
  it('processes a success callback with TransactionDate as a 14-digit number', async () => {
    const storage = await makeStorage('ws_CO_txdate_001')
    const cb = mockCallbackSuccess({
      checkoutRequestId: 'ws_CO_txdate_001',
      amount: 100,
      transactionDate: 20191219102115,
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('SUCCESS')
    const payment = await storage.getPaymentByCheckoutId('ws_CO_txdate_001')
    expect(payment?.rawCallback).toBeDefined()
  })
})

describe('Balance item in callback metadata (optional)', () => {
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
              { Name: 'Balance', Value: 5000 },
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
