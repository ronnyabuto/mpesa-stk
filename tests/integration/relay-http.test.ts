import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRelayServer } from '../../src/server/relay.js'
import { scheduleDelivery } from '../../src/server/delivery.js'
import type { RelayStorage, RelayApp, DeliveryEvent } from '../../src/server/types.js'

vi.mock('../../src/server/delivery.js', () => ({
  scheduleDelivery: vi.fn(),
}))

function makeStorage(): RelayStorage {
  const apps = new Map<string, RelayApp>()
  const events = new Map<string, DeliveryEvent>()
  const eventIdx = new Map<string, string>() // `${appId}:${checkoutId}` → eventId

  return {
    async createApp(app) {
      const record: RelayApp = { ...app, createdAt: new Date() }
      apps.set(app.appId, record)
      return record
    },
    async getApp(appId) {
      return apps.get(appId) ?? null
    },
    async updateAppTargetUrl(appId, targetUrl) {
      const app = apps.get(appId)
      if (app) apps.set(appId, { ...app, targetUrl })
    },
    async insertEventIfAbsent(event) {
      const key = `${event.appId}:${event.checkoutRequestId}`
      const existingId = eventIdx.get(key)
      if (existingId) {
        return { inserted: false, event: events.get(existingId)! }
      }
      const full: DeliveryEvent = { ...event, createdAt: new Date(), deliveredAt: null }
      events.set(event.id, full)
      eventIdx.set(key, event.id)
      return { inserted: true, event: full }
    },
    async getEvent(id) {
      return events.get(id) ?? null
    },
    async updateEvent(id, updates) {
      const e = events.get(id)
      if (e) events.set(id, { ...e, ...updates } as DeliveryEvent)
    },
    async getEventByCheckoutId(checkoutRequestId, appId) {
      const key = `${appId}:${checkoutRequestId}`
      const id = eventIdx.get(key)
      return id ? (events.get(id) ?? null) : null
    },
    async getDueEvents() { return [] },
    async migrate() {},
  }
}

function makeCallback(checkoutRequestId: string) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: checkoutRequestId,
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
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /apps — app registration', () => {
  it('creates an app and returns appId, signingSecret, and hookUrl', async () => {
    const relay = createRelayServer({ storage: makeStorage() })
    const res = await relay.request('/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'https://example.com/webhook' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.appId).toBe('string')
    expect(typeof body.signingSecret).toBe('string')
    expect(body.hookUrl).toMatch(/^\/hooks\//)
  })

  it('rejects a non-HTTPS targetUrl with 400', async () => {
    const relay = createRelayServer({ storage: makeStorage() })
    const res = await relay.request('/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://example.com/webhook' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a request with no targetUrl with 400', async () => {
    const relay = createRelayServer({ storage: makeStorage() })
    const res = await relay.request('/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /apps/:appId — update target URL', () => {
  async function registerApp(relay: ReturnType<typeof createRelayServer>) {
    const res = await relay.request('/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'https://example.com/webhook' }),
    })
    return res.json() as Promise<{ appId: string; signingSecret: string }>
  }

  it('updates targetUrl when the correct Bearer secret is provided', async () => {
    const storage = makeStorage()
    const relay = createRelayServer({ storage })
    const { appId, signingSecret } = await registerApp(relay)

    const res = await relay.request(`/apps/${appId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${signingSecret}`,
      },
      body: JSON.stringify({ targetUrl: 'https://new.example.com/webhook' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.targetUrl).toBe('https://new.example.com/webhook')
  })

  it('returns 401 when the Bearer secret is wrong', async () => {
    const storage = makeStorage()
    const relay = createRelayServer({ storage })
    const { appId } = await registerApp(relay)

    const res = await relay.request(`/apps/${appId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-secret',
      },
      body: JSON.stringify({ targetUrl: 'https://new.example.com/webhook' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 when the Authorization header is absent', async () => {
    const storage = makeStorage()
    const relay = createRelayServer({ storage })
    const { appId } = await registerApp(relay)

    const res = await relay.request(`/apps/${appId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'https://new.example.com/webhook' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 for an unknown appId', async () => {
    const relay = createRelayServer({ storage: makeStorage() })
    const res = await relay.request('/apps/does-not-exist', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer some-secret',
      },
      body: JSON.stringify({ targetUrl: 'https://new.example.com/webhook' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /hooks/:appId — inbound Safaricom callback', () => {
  // Safaricom requires HTTP 200 regardless of outcome — returning 4xx causes
  // Safaricom to consider the delivery failed, which breaks their retry flow.

  it('accepts a valid callback, returns ResultCode 0, and queues delivery', async () => {
    const storage = makeStorage()
    await storage.createApp({
      appId: 'app-001',
      targetUrl: 'https://example.com/webhook',
      signingSecret: 'test-secret',
    })
    const relay = createRelayServer({ storage })

    const res = await relay.request('/hooks/app-001', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeCallback('ws_CO_relay_001')),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.ResultCode).toBe(0)
    expect(vi.mocked(scheduleDelivery)).toHaveBeenCalledOnce()
  })

  it('returns 200 for an unknown appId — Safaricom must always see 200', async () => {
    const relay = createRelayServer({ storage: makeStorage() })
    const res = await relay.request('/hooks/unknown-app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeCallback('ws_CO_relay_002')),
    })
    expect(res.status).toBe(200)
    expect(vi.mocked(scheduleDelivery)).not.toHaveBeenCalled()
  })

  it('returns 200 for a structurally invalid callback body — Safaricom must always see 200', async () => {
    const storage = makeStorage()
    await storage.createApp({
      appId: 'app-002',
      targetUrl: 'https://example.com/webhook',
      signingSecret: 'test-secret',
    })
    const relay = createRelayServer({ storage })

    const res = await relay.request('/hooks/app-002', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: 'payload' }),
    })
    expect(res.status).toBe(200)
    expect(vi.mocked(scheduleDelivery)).not.toHaveBeenCalled()
  })

  it('deduplicates a duplicate callback — second send returns 200 and does not re-queue', async () => {
    const storage = makeStorage()
    await storage.createApp({
      appId: 'app-003',
      targetUrl: 'https://example.com/webhook',
      signingSecret: 'test-secret',
    })
    const relay = createRelayServer({ storage })
    const body = JSON.stringify(makeCallback('ws_CO_dup_relay_001'))

    const first = await relay.request('/hooks/app-003', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const second = await relay.request('/hooks/app-003', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // scheduleDelivery is only called once — the duplicate is silently dropped
    expect(vi.mocked(scheduleDelivery)).toHaveBeenCalledOnce()
  })
})

describe('GET /status/:checkoutRequestId — delivery status query', () => {
  it('returns the event status for a known checkoutRequestId', async () => {
    const storage = makeStorage()
    await storage.createApp({
      appId: 'app-004',
      targetUrl: 'https://example.com/webhook',
      signingSecret: 'test-secret',
    })
    const relay = createRelayServer({ storage })

    // Register a callback so an event exists
    await relay.request('/hooks/app-004', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeCallback('ws_CO_status_001')),
    })

    const res = await relay.request('/status/ws_CO_status_001?app_id=app-004')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.checkoutRequestId).toBe('ws_CO_status_001')
    expect(body.status).toBe('PENDING')
    expect(body.appId).toBe('app-004')
  })

  it('returns 404 for an unknown checkoutRequestId', async () => {
    const relay = createRelayServer({ storage: makeStorage() })
    const res = await relay.request('/status/ws_CO_unknown?app_id=app-001')
    expect(res.status).toBe(404)
  })

  it('returns 400 when the app_id query param is missing', async () => {
    const relay = createRelayServer({ storage: makeStorage() })
    const res = await relay.request('/status/ws_CO_001')
    expect(res.status).toBe(400)
  })
})
