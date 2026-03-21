import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryAdapter } from '../src/adapters/memory.js'
import { processCallback } from '../src/callback.js'
import type { PaymentRecord } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-001',
    checkoutRequestId: 'ws_CO_011120241020363925',
    merchantRequestId: '29115-34620561-1',
    phoneNumber: '254712345678',   // original, unmasked
    amount: 100,
    accountReference: 'ORDER-1',
    status: 'PENDING',
    initiatedAt: new Date('2024-11-01T10:00:00Z'),
    ...overrides,
  }
}

function successCallback(overrides: Record<string, unknown> = {}) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_011120241020363925',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 100 },
            { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
            { Name: 'TransactionDate', Value: 20241101102115 },
            // Phone number is masked — 2026 reality
            { Name: 'PhoneNumber', Value: '254712***678' },
          ],
        },
        ...overrides,
      },
    },
  }
}

function failureCallback(resultCode: number, resultDesc: string) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_011120241020363925',
        ResultCode: resultCode,
        ResultDesc: resultDesc,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processCallback', () => {
  let adapter: MemoryAdapter

  beforeEach(() => {
    adapter = new MemoryAdapter()
  })

  it('valid success callback — status becomes SUCCESS, receipt stored, original phone NOT overwritten', async () => {
    await adapter.createPayment(makeRecord())

    const result = await processCallback(successCallback(), adapter)

    expect(result.status).toBe('SUCCESS')
    expect(result.isDuplicate).toBe(false)
    expect(result.receipt).toBe('NLJ7RT61SV')

    const stored = await adapter.getPayment('pay-001')
    expect(stored?.status).toBe('SUCCESS')
    expect(stored?.mpesaReceiptNumber).toBe('NLJ7RT61SV')
    // Original unmasked phone number must be preserved
    expect(stored?.phoneNumber).toBe('254712345678')
  })

  it('failure callback ResultCode 1032 — status becomes CANCELLED', async () => {
    await adapter.createPayment(makeRecord())

    const result = await processCallback(failureCallback(1032, 'Request cancelled by user.'), adapter)

    expect(result.status).toBe('CANCELLED')
    expect(result.isDuplicate).toBe(false)

    const stored = await adapter.getPayment('pay-001')
    expect(stored?.status).toBe('CANCELLED')
    expect(stored?.resultCode).toBe(1032)
  })

  it('failure callback ResultCode 1 — status becomes FAILED, resultCode stored', async () => {
    await adapter.createPayment(makeRecord())

    const result = await processCallback(failureCallback(1, 'Insufficient funds.'), adapter)

    expect(result.status).toBe('FAILED')
    expect(result.isDuplicate).toBe(false)

    const stored = await adapter.getPayment('pay-001')
    expect(stored?.status).toBe('FAILED')
    expect(stored?.resultCode).toBe(1)
    expect(stored?.failureReason).toBe('Insufficient funds.')
  })

  it('duplicate success callback — isDuplicate: true, record unchanged', async () => {
    // Pre-populate with an already-settled payment
    await adapter.createPayment(makeRecord({ status: 'SUCCESS', mpesaReceiptNumber: 'NLJ7RT61SV' }))

    const result = await processCallback(successCallback(), adapter)

    expect(result.isDuplicate).toBe(true)
    expect(result.status).toBe('SUCCESS')
    // The record must not have been modified (completedAt would change if re-processed)
    const stored = await adapter.getPayment('pay-001')
    expect(stored?.completedAt).toBeUndefined()
  })

  it('malformed callback missing Body — throws with clear message', async () => {
    await expect(processCallback({ noBody: true }, adapter)).rejects.toThrow(
      /Invalid callback structure/
    )
  })

  it('malformed callback missing stkCallback — throws', async () => {
    await expect(processCallback({ Body: {} }, adapter)).rejects.toThrow(
      /Invalid callback structure/
    )
  })

  it('amount mismatch — expected 100, received 999 — throws', async () => {
    await adapter.createPayment(makeRecord({ amount: 100 }))

    const cb = successCallback()
    // Override the Amount item
    ;(cb.Body.stkCallback as unknown as {
      CallbackMetadata: { Item: Array<{ Name: string; Value: number }> }
    }).CallbackMetadata.Item[0]!.Value = 999

    await expect(processCallback(cb, adapter)).rejects.toThrow(
      /amount mismatch/i
    )
  })

  it('unknown ResultCode 9999 — status becomes FAILED', async () => {
    await adapter.createPayment(makeRecord())

    const result = await processCallback(failureCallback(9999, 'Unknown error'), adapter)

    expect(result.status).toBe('FAILED')

    const stored = await adapter.getPayment('pay-001')
    expect(stored?.status).toBe('FAILED')
    expect(stored?.resultCode).toBe(9999)
  })

  it('success callback with PhoneNumber absent from metadata — still processes correctly', async () => {
    await adapter.createPayment(makeRecord())

    // Simulate Safaricom omitting PhoneNumber entirely
    const cb = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_011120241020363925',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 100 },
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'TransactionDate', Value: 20241101102115 },
              // No PhoneNumber item
            ],
          },
        },
      },
    }

    const result = await processCallback(cb, adapter)
    expect(result.status).toBe('SUCCESS')
    // Original phone must still be intact
    const stored = await adapter.getPayment('pay-001')
    expect(stored?.phoneNumber).toBe('254712345678')
  })
})
