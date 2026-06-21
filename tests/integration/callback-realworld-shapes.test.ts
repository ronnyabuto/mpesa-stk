import { describe, it, expect } from 'vitest'
import { processCallback } from '../../src/callback.js'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import type { PaymentRecord } from '../../src/types.js'

// Real Safaricom callbacks vary more than the canonical example: metadata item
// ORDER is not guaranteed, Amount/TransactionDate types differ between sources
// (UNVERIFIED_BEHAVIORS #3), and some fields are masked or absent. These assert
// the processor survives the variation a production integration actually sees.

async function storageWith(checkoutRequestId: string, amount = 100) {
  const s = new MemoryAdapter()
  const rec: PaymentRecord = {
    id: 'pay-1', checkoutRequestId, merchantRequestId: 'm-1', phoneNumber: '254708374149',
    amount, accountReference: 'ORDER-1', status: 'PENDING', initiatedAt: new Date(),
  }
  await s.createPayment(rec)
  return s
}

function success(checkoutRequestId: string, items: Array<{ Name: string; Value?: string | number }>) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'm-1', CheckoutRequestID: checkoutRequestId,
        ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: { Item: items },
      },
    },
  }
}

describe('callback metadata — item ordering and types vary in production', () => {
  it('extracts fields regardless of item order (Safaricom does not guarantee order)', async () => {
    const s = await storageWith('ws_CO_order')
    // Receipt first, Amount last — opposite of the canonical example.
    const cb = success('ws_CO_order', [
      { Name: 'MpesaReceiptNumber', Value: 'QHJ7XYZ123' },
      { Name: 'PhoneNumber', Value: 254708374149 },
      { Name: 'TransactionDate', Value: 20241101102115 },
      { Name: 'Amount', Value: 100 },
    ])
    const r = await processCallback(cb, s)
    expect(r.status).toBe('SUCCESS')
    expect(r.receipt).toBe('QHJ7XYZ123')
  })

  it('accepts TransactionDate as a STRING "YYYY-MM-DD HH:MM:SS" (conflicting-source form)', async () => {
    const s = await storageWith('ws_CO_txstr')
    const cb = success('ws_CO_txstr', [
      { Name: 'Amount', Value: 100 },
      { Name: 'MpesaReceiptNumber', Value: 'QHJ7XYZ123' },
      { Name: 'TransactionDate', Value: '2026-04-26 12:30:00' },
    ])
    const r = await processCallback(cb, s)
    expect(r.status).toBe('SUCCESS')
    // Stored verbatim in rawCallback, not parsed — so either type is safe.
    const stored = await s.getPaymentByCheckoutId('ws_CO_txstr')
    expect(stored?.rawCallback).toBeDefined()
  })

  it('accepts Amount as a float (100.00) within ±1 tolerance', async () => {
    const s = await storageWith('ws_CO_float', 100)
    const cb = success('ws_CO_float', [
      { Name: 'Amount', Value: 100.0 },
      { Name: 'MpesaReceiptNumber', Value: 'QHJ7XYZ123' },
    ])
    expect((await processCallback(cb, s)).status).toBe('SUCCESS')
  })

  it('accepts Amount delivered as a numeric STRING "100" (JS coercion stays within tolerance)', async () => {
    const s = await storageWith('ws_CO_amtstr', 100)
    const cb = success('ws_CO_amtstr', [
      { Name: 'Amount', Value: '100' },
      { Name: 'MpesaReceiptNumber', Value: 'QHJ7XYZ123' },
    ])
    expect((await processCallback(cb, s)).status).toBe('SUCCESS')
  })

  it('still rejects a genuinely wrong amount even when delivered as a string', async () => {
    const s = await storageWith('ws_CO_amtwrong', 100)
    const cb = success('ws_CO_amtwrong', [
      { Name: 'Amount', Value: '5000' },
      { Name: 'MpesaReceiptNumber', Value: 'QHJ7XYZ123' },
    ])
    await expect(processCallback(cb, s)).rejects.toThrow(/amount mismatch/i)
  })

  it('processes a success callback whose CallbackMetadata.Item is empty (no receipt/amount)', async () => {
    const s = await storageWith('ws_CO_empty', 100)
    const cb = success('ws_CO_empty', [])
    const r = await processCallback(cb, s)
    // No amount to validate, no receipt to store — still a clean SUCCESS.
    expect(r.status).toBe('SUCCESS')
    expect(r.receipt).toBeUndefined()
  })
})

describe('failure callbacks — the exact shapes Safaricom sends', () => {
  it.each([
    [1037, '[STK DS timeout] DS timeout user cannot be reached.', 'TIMEOUT'],
    [1032, 'Request cancelled by user', 'CANCELLED'],
    [1, 'The balance is insufficient for the transaction.', 'FAILED'],
    [2001, 'The initiator information is invalid.', 'FAILED'],
    [1019, 'Transaction has expired', 'EXPIRED'],
    [1001, 'Unable to lock subscriber, a transaction is already in process.', 'FAILED'],
  ])('ResultCode %i ("%s") → %s', async (code, desc, expected) => {
    const s = await storageWith(`ws_CO_f_${code}`)
    const cb = {
      Body: { stkCallback: { MerchantRequestID: 'm-1', CheckoutRequestID: `ws_CO_f_${code}`, ResultCode: code, ResultDesc: desc } },
    }
    const r = await processCallback(cb, s)
    expect(r.status).toBe(expected)
    const stored = await s.getPaymentByCheckoutId(`ws_CO_f_${code}`)
    expect(stored?.resultCode).toBe(code)
    expect(stored?.failureReason).toBe(desc)
  })
})
