import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { scheduleDelivery, recoverPendingDeliveries } from '../../src/server/delivery.js'
import { verifySignature } from '../../src/server/signing.js'
import type { RelayApp, DeliveryEvent, RelayStorage } from '../../src/server/types.js'

// The delivery engine is the relay's whole reliability story: it absorbs a flaky
// target app and redelivers with backoff until success or dead-letter. None of
// that runs in relay-http.test.ts (which mocks scheduleDelivery out), so these
// tests exercise the real engine end to end.

// --- A complete in-memory RelayStorage (supports getEvent/updateEvent/getDueEvents) ---
function makeStorage() {
  const apps = new Map<string, RelayApp>()
  const events = new Map<string, DeliveryEvent>()
  const idx = new Map<string, string>()

  const storage: RelayStorage = {
    async createApp(app) {
      const rec: RelayApp = { ...app, createdAt: new Date() }
      apps.set(app.appId, rec)
      return rec
    },
    async getApp(appId) { return apps.get(appId) ?? null },
    async updateAppTargetUrl(appId, targetUrl) {
      const a = apps.get(appId); if (a) apps.set(appId, { ...a, targetUrl })
    },
    async insertEventIfAbsent(event) {
      const key = `${event.appId}:${event.checkoutRequestId}`
      const existing = idx.get(key)
      if (existing) return { inserted: false, event: events.get(existing)! }
      const full: DeliveryEvent = { ...event, createdAt: new Date(), deliveredAt: null }
      events.set(event.id, full); idx.set(key, event.id)
      return { inserted: true, event: full }
    },
    async getEvent(id) { return events.get(id) ?? null },
    async updateEvent(id, updates) {
      const e = events.get(id); if (e) events.set(id, { ...e, ...updates } as DeliveryEvent)
    },
    async getEventByCheckoutId(checkoutRequestId, appId) {
      const id = idx.get(`${appId}:${checkoutRequestId}`)
      return id ? (events.get(id) ?? null) : null
    },
    async getDueEvents() {
      const now = new Date()
      return [...events.values()].filter(
        (e) => (e.status === 'PENDING' || e.status === 'FAILED') && (!e.nextAttemptAt || e.nextAttemptAt <= now)
      )
    },
    async migrate() {},
  }
  return { storage, events }
}

const APP: RelayApp = {
  appId: 'app-1',
  targetUrl: 'https://merchant.example.com/mpesa/callback',
  signingSecret: 'f'.repeat(64),
  createdAt: new Date(),
}

const PAYLOAD = {
  Body: { stkCallback: { MerchantRequestID: 'm-1', CheckoutRequestID: 'ws_CO_d1', ResultCode: 0, ResultDesc: 'ok' } },
}

function newEvent(over: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    id: 'evt-1', appId: APP.appId, checkoutRequestId: 'ws_CO_d1', payload: PAYLOAD,
    status: 'PENDING', attemptCount: 0, nextAttemptAt: null, lastError: null,
    createdAt: new Date(), deliveredAt: null, ...over,
  }
}

// fetch mock that returns a queue of outcomes; each outcome is an HTTP status or 'throw'
function mockFetch(outcomes: Array<number | 'throw'>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  let i = 0
  const fn = vi.fn(async (url: string, opts: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: opts.headers, body: opts.body })
    const outcome = outcomes[Math.min(i, outcomes.length - 1)]
    i++
    if (outcome === 'throw') throw new Error('network down')
    return { ok: outcome >= 200 && outcome < 300, status: outcome } as Response
  })
  return { fn, calls }
}

async function flush(times = 6) { for (let i = 0; i < times; i++) await Promise.resolve() }

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('delivery — happy path and signature', () => {
  it('delivers on first try, marks DELIVERED, and sends a verifiable HMAC signature', async () => {
    const { storage, events } = makeStorage()
    await storage.createApp(APP)
    const event = newEvent()
    events.set(event.id, event)

    const { fn, calls } = mockFetch([200])
    vi.stubGlobal('fetch', fn)

    scheduleDelivery(event, APP, storage)
    await flush()

    const stored = await storage.getEvent('evt-1')
    expect(stored?.status).toBe('DELIVERED')
    expect(stored?.attemptCount).toBe(1)
    expect(stored?.deliveredAt).toBeInstanceOf(Date)

    // The outbound request must carry a signature the merchant app can verify.
    expect(calls).toHaveLength(1)
    const sig = calls[0]!.headers['X-Mpesa-Signature']!
    expect(verifySignature(calls[0]!.body, APP.signingSecret, sig)).toBe(true)
    expect(calls[0]!.headers['X-Mpesa-Event-Id']).toBe('evt-1')
    expect(calls[0]!.headers['X-Mpesa-Timestamp']).toMatch(/^\d+$/)
    // A merchant verifying with the WRONG secret must reject it.
    expect(verifySignature(calls[0]!.body, 'wrong'.repeat(13), sig)).toBe(false)
  })
})

describe('delivery — retry ladder against a flaky target', () => {
  it('a target that is down then recovers gets the callback delivered (FAILED → retry → DELIVERED)', async () => {
    const { storage, events } = makeStorage()
    await storage.createApp(APP)
    const event = newEvent()
    events.set(event.id, event)

    // 500 on the first attempt, 200 on the retry 30s later.
    const { fn, calls } = mockFetch([500, 200])
    vi.stubGlobal('fetch', fn)

    scheduleDelivery(event, APP, storage)
    await flush()

    let stored = await storage.getEvent('evt-1')
    expect(stored?.status).toBe('FAILED')
    expect(stored?.attemptCount).toBe(1)
    expect(stored?.nextAttemptAt).toBeInstanceOf(Date)
    expect(stored?.lastError).toMatch(/HTTP 500/)

    // Advance to the first retry (30s).
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()

    stored = await storage.getEvent('evt-1')
    expect(stored?.status).toBe('DELIVERED')
    expect(stored?.attemptCount).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('a network error (not just an HTTP error) is treated as a failed attempt and retried', async () => {
    const { storage, events } = makeStorage()
    await storage.createApp(APP)
    const event = newEvent()
    events.set(event.id, event)

    const { fn } = mockFetch(['throw', 200])
    vi.stubGlobal('fetch', fn)

    scheduleDelivery(event, APP, storage)
    await flush()
    expect((await storage.getEvent('evt-1'))?.status).toBe('FAILED')
    expect((await storage.getEvent('evt-1'))?.lastError).toMatch(/network down/)

    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect((await storage.getEvent('evt-1'))?.status).toBe('DELIVERED')
  })
})

describe('delivery — dead-lettering a permanently-down target', () => {
  it('exhausts 6 attempts across the full backoff ladder then marks DEAD with lastError', async () => {
    const { storage, events } = makeStorage()
    await storage.createApp(APP)
    const event = newEvent()
    events.set(event.id, event)

    const { fn, calls } = mockFetch([500]) // always 500
    vi.stubGlobal('fetch', fn)

    scheduleDelivery(event, APP, storage)
    await flush()

    // Walk the documented ladder: 30s → 2m → 10m → 30m → 2h.
    for (const delay of [30_000, 120_000, 600_000, 1_800_000, 7_200_000]) {
      await vi.advanceTimersByTimeAsync(delay)
      await flush()
    }

    const stored = await storage.getEvent('evt-1')
    expect(stored?.status).toBe('DEAD')
    expect(stored?.attemptCount).toBe(6)
    expect(stored?.lastError).toMatch(/HTTP 500/)
    expect(calls).toHaveLength(6) // initial + 5 retries
  })
})

describe('delivery — restart recovery', () => {
  it('recoverPendingDeliveries re-drives a FAILED event whose retry was lost on restart', async () => {
    const { storage, events } = makeStorage()
    await storage.createApp(APP)
    // Simulate a server that crashed after scheduling a retry: a FAILED event
    // with a nextAttemptAt already in the past and no live setTimeout.
    events.set('evt-1', newEvent({ status: 'FAILED', attemptCount: 1, nextAttemptAt: new Date(Date.now() - 1000) }))

    const { fn } = mockFetch([200])
    vi.stubGlobal('fetch', fn)

    await recoverPendingDeliveries(storage)
    await flush()

    const stored = await storage.getEvent('evt-1')
    expect(stored?.status).toBe('DELIVERED')
    expect(stored?.attemptCount).toBe(2)
  })

  it('does not re-deliver an already-DELIVERED event', async () => {
    const { storage, events } = makeStorage()
    await storage.createApp(APP)
    events.set('evt-1', newEvent({ status: 'DELIVERED', attemptCount: 1, deliveredAt: new Date() }))

    const { fn, calls } = mockFetch([200])
    vi.stubGlobal('fetch', fn)

    await recoverPendingDeliveries(storage)
    await flush()

    expect(calls).toHaveLength(0)
    expect((await storage.getEvent('evt-1'))?.status).toBe('DELIVERED')
  })
})
