import { describe, it, expect } from 'vitest'
import { resultCodeToStatus } from '../../src/callback.js'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import { processCallback } from '../../src/callback.js'
import {
  mockCallbackSuccess,
  mockCallbackFailure,
} from './helpers/mocks.js'

describe('resultCodeToStatus — confirmed ResultCodes', () => {
  it('maps ResultCode 0 to SUCCESS', () => {
    expect(resultCodeToStatus(0)).toBe('SUCCESS')
  })

  it('maps ResultCode 1 (insufficient balance) to FAILED', () => {
    expect(resultCodeToStatus(1)).toBe('FAILED')
  })

  it('maps ResultCode 1001 (subscriber lock) to FAILED', () => {
    expect(resultCodeToStatus(1001)).toBe('FAILED')
  })

  it('maps ResultCode 1019 (transaction expired) to EXPIRED', () => {
    expect(resultCodeToStatus(1019)).toBe('EXPIRED')
  })

  it('maps ResultCode 1025 (issue sending push) to FAILED', () => {
    expect(resultCodeToStatus(1025)).toBe('FAILED')
  })

  it('maps ResultCode 1032 (user cancelled) to CANCELLED', () => {
    expect(resultCodeToStatus(1032)).toBe('CANCELLED')
  })

  it('maps ResultCode 1037 (user unreachable / DS timeout) to TIMEOUT', () => {
    expect(resultCodeToStatus(1037)).toBe('TIMEOUT')
  })

  it('maps ResultCode 2001 (wrong PIN / invalid initiator) to FAILED', () => {
    expect(resultCodeToStatus(2001)).toBe('FAILED')
  })

  it('maps ResultCode 9999 (general error / message too long) to FAILED', () => {
    expect(resultCodeToStatus(9999)).toBe('FAILED')
  })

  it('maps any unknown/undocumented ResultCode to FAILED (safe default)', () => {
    expect(resultCodeToStatus(99999)).toBe('FAILED')
    expect(resultCodeToStatus(-1)).toBe('FAILED')
    expect(resultCodeToStatus(500)).toBe('FAILED')
  })
})

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

  it('processes a ResultCode 1032 (user cancelled) callback and returns CANCELLED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_cancel_001')
    const cb = mockCallbackFailure(1032, 'Request cancelled by user', {
      checkoutRequestId: 'ws_CO_cancel_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('CANCELLED')
    expect(result.isDuplicate).toBe(false)
    expect(result.receipt).toBeUndefined()

    const payment = await storage.getPaymentByCheckoutId('ws_CO_cancel_001')
    expect(payment?.status).toBe('CANCELLED')
    expect(payment?.failureReason).toBe('Request cancelled by user')
    expect(payment?.resultCode).toBe(1032)
  })

  it('processes a ResultCode 1037 (DS timeout) callback and returns TIMEOUT status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_timeout_001')
    const cb = mockCallbackFailure(1037, '[STK DS timeout] Request timeout.', {
      checkoutRequestId: 'ws_CO_timeout_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('TIMEOUT')
  })

  it('processes a ResultCode 1 (insufficient balance) callback and returns FAILED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_funds_001')
    const cb = mockCallbackFailure(1, 'The balance is insufficient for the transaction.', {
      checkoutRequestId: 'ws_CO_funds_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('FAILED')
  })

  it('processes a ResultCode 2001 (wrong PIN) callback and returns FAILED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_pin_001')
    const cb = mockCallbackFailure(2001, 'Invalid initiator information.', {
      checkoutRequestId: 'ws_CO_pin_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('FAILED')
  })

  it('processes a ResultCode 1019 (expired) callback and returns EXPIRED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_expired_001')
    const cb = mockCallbackFailure(1019, 'Transaction expired.', {
      checkoutRequestId: 'ws_CO_expired_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('EXPIRED')
  })

  it('processes a ResultCode 9999 (general error) callback and returns FAILED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_9999_001')
    const cb = mockCallbackFailure(9999, 'Unable to send push request.', {
      checkoutRequestId: 'ws_CO_9999_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('FAILED')
  })

  it('processes a ResultCode 1001 (subscriber lock) callback and returns FAILED status', async () => {
    const { storage } = await makePaymentRecord('ws_CO_1001_001')
    const cb = mockCallbackFailure(1001, 'Unable to lock subscriber, a previous transaction is in process.', {
      checkoutRequestId: 'ws_CO_1001_001',
    })

    const result = await processCallback(cb, storage)
    expect(result.status).toBe('FAILED')
  })

  it.todo('maps ResultCode 17 (transaction limit exceeded) — needs source confirmation')
})

describe('callback processing — resultCode stored on payment record', () => {
  it('stores the raw resultCode on the payment record for audit purposes', async () => {
    const { storage } = await makePaymentRecord('ws_CO_audit_001')
    const cb = mockCallbackFailure(1037, '[STK DS timeout] Request timeout.', {
      checkoutRequestId: 'ws_CO_audit_001',
    })

    await processCallback(cb, storage)
    const payment = await storage.getPaymentByCheckoutId('ws_CO_audit_001')
    expect(payment?.resultCode).toBe(1037)
  })

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
