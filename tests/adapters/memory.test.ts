import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryAdapter } from '../../src/adapters/memory.js'
import type { PaymentRecord } from '../../src/types.js'

function makeRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-001',
    checkoutRequestId: 'ws_CO_001',
    merchantRequestId: 'merch-001',
    phoneNumber: '254712345678',
    amount: 100,
    accountReference: 'ORDER-1',
    status: 'PENDING',
    initiatedAt: new Date('2024-11-01T10:00:00Z'),
    ...overrides,
  }
}

describe('MemoryAdapter', () => {
  let adapter: MemoryAdapter

  beforeEach(() => {
    adapter = new MemoryAdapter()
  })

  it('creates and retrieves a payment by id', async () => {
    const record = makeRecord()
    await adapter.createPayment(record)
    const found = await adapter.getPayment('pay-001')
    expect(found).toMatchObject({ id: 'pay-001', status: 'PENDING' })
  })

  it('returns null for missing id', async () => {
    expect(await adapter.getPayment('does-not-exist')).toBeNull()
  })

  it('finds by checkoutRequestId', async () => {
    await adapter.createPayment(makeRecord())
    const found = await adapter.getPaymentByCheckoutId('ws_CO_001')
    expect(found?.id).toBe('pay-001')
  })

  it('finds by idempotency key after registration', async () => {
    await adapter.createPayment(makeRecord())
    adapter.registerIdempotencyKey('idem-key-1', 'pay-001')
    const found = await adapter.getPaymentByIdempotencyKey('idem-key-1')
    expect(found?.id).toBe('pay-001')
  })

  it('returns null for unknown idempotency key', async () => {
    expect(await adapter.getPaymentByIdempotencyKey('unknown')).toBeNull()
  })

  it('updates a payment', async () => {
    await adapter.createPayment(makeRecord())
    await adapter.updatePayment('pay-001', { status: 'SUCCESS', mpesaReceiptNumber: 'NLJ7RT61SV' })
    const updated = await adapter.getPayment('pay-001')
    expect(updated?.status).toBe('SUCCESS')
    expect(updated?.mpesaReceiptNumber).toBe('NLJ7RT61SV')
  })

  it('throws when updating a non-existent payment', async () => {
    await expect(adapter.updatePayment('ghost', { status: 'FAILED' })).rejects.toThrow()
  })

  it('filters by status and date range', async () => {
    const records: PaymentRecord[] = [
      makeRecord({ id: 'p1', checkoutRequestId: 'c1', status: 'PENDING', initiatedAt: new Date('2024-11-01T10:00:00Z') }),
      makeRecord({ id: 'p2', checkoutRequestId: 'c2', status: 'SUCCESS', initiatedAt: new Date('2024-11-01T11:00:00Z') }),
      makeRecord({ id: 'p3', checkoutRequestId: 'c3', status: 'PENDING', initiatedAt: new Date('2024-11-01T12:00:00Z') }),
      makeRecord({ id: 'p4', checkoutRequestId: 'c4', status: 'PENDING', initiatedAt: new Date('2024-11-02T10:00:00Z') }),
    ]
    for (const r of records) await adapter.createPayment(r)

    const from = new Date('2024-11-01T09:00:00Z')
    const to = new Date('2024-11-01T23:59:59Z')
    const results = await adapter.getPaymentsByStatusAndDateRange('PENDING', from, to)

    expect(results.map((r) => r.id).sort()).toEqual(['p1', 'p3'])
  })

  it('does not mutate stored records when the returned object is modified', async () => {
    await adapter.createPayment(makeRecord())
    const record = await adapter.getPayment('pay-001')
    record!.status = 'SUCCESS'
    const refetch = await adapter.getPayment('pay-001')
    expect(refetch?.status).toBe('PENDING')
  })
})
