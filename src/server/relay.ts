import { randomUUID, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { validateCallbackStructure } from '../validate.js'
import { scheduleDelivery } from './delivery.js'
import type { RelayServerConfig } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSigningSecret(): string {
  return randomBytes(32).toString('hex')
}

// ---------------------------------------------------------------------------
// createRelayServer
// ---------------------------------------------------------------------------

/**
 * Build the relay HTTP app.
 *
 * Returns a Hono app — serve it with @hono/node-server, Bun.serve, or
 * Cloudflare Workers depending on your deployment target.
 *
 * Routes:
 *   POST /apps                          — register a new app
 *   PATCH /apps/:appId                  — update target URL (auth: signing secret)
 *   POST /hooks/:appId                  — Safaricom posts callbacks here
 *   GET  /status/:checkoutRequestId     — query delivery status
 *                                         query param: ?app_id=<appId>
 */
export function createRelayServer(config: RelayServerConfig) {
  const { storage, logger } = config
  const app = new Hono()

  // ---------------------------------------------------------------------------
  // POST /apps — register an application
  // ---------------------------------------------------------------------------

  app.post('/apps', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be JSON' }, 400)
    }

    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'Request body must be a JSON object' }, 400)
    }

    const { targetUrl } = body as Record<string, unknown>

    if (typeof targetUrl !== 'string' || !targetUrl.startsWith('https://')) {
      return c.json({ error: 'targetUrl is required and must start with https://' }, 400)
    }

    const appId = randomUUID()
    const signingSecret = generateSigningSecret()

    const created = await storage.createApp({ appId, targetUrl, signingSecret })

    logger?.info('App registered', { appId, targetUrl })

    return c.json({
      appId: created.appId,
      // The signing secret is returned once and never again. Store it securely.
      signingSecret: created.signingSecret,
      hookUrl: `/hooks/${created.appId}`,
      createdAt: created.createdAt.toISOString(),
    }, 201)
  })

  // ---------------------------------------------------------------------------
  // PATCH /apps/:appId — update target URL
  // Auth: pass the signing secret as Bearer token
  // ---------------------------------------------------------------------------

  app.patch('/apps/:appId', async (c) => {
    const { appId } = c.req.param()

    const app = await storage.getApp(appId)
    if (!app) {
      return c.json({ error: 'App not found' }, 404)
    }

    // Authenticate using the signing secret
    const authHeader = c.req.header('Authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (token !== app.signingSecret) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be JSON' }, 400)
    }

    const { targetUrl } = (body ?? {}) as Record<string, unknown>

    if (typeof targetUrl !== 'string' || !targetUrl.startsWith('https://')) {
      return c.json({ error: 'targetUrl must be a string starting with https://' }, 400)
    }

    await storage.updateAppTargetUrl(appId, targetUrl)
    logger?.info('App target URL updated', { appId, targetUrl })

    return c.json({ appId, targetUrl })
  })

  // ---------------------------------------------------------------------------
  // POST /hooks/:appId — inbound Safaricom callback
  // ---------------------------------------------------------------------------

  app.post('/hooks/:appId', async (c) => {
    const { appId } = c.req.param()

    // Safaricom requires a response within 5 seconds. We validate, persist,
    // then ACK — delivery to the developer's app happens asynchronously after.

    const relayApp = await storage.getApp(appId)
    if (!relayApp) {
      // Still return 200 to Safaricom — returning 4xx causes Safaricom to
      // consider the callback failed and it won't retry (there are no retries
      // anyway, but we don't want to break their delivery flow).
      logger?.warn('Callback received for unknown appId', { appId })
      return c.json({ ResultCode: 0, ResultDesc: 'Success' })
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      logger?.warn('Malformed JSON in callback body', { appId })
      return c.json({ ResultCode: 0, ResultDesc: 'Success' })
    }

    if (!validateCallbackStructure(body)) {
      logger?.warn('Callback failed structural validation', { appId })
      return c.json({ ResultCode: 0, ResultDesc: 'Success' })
    }

    const checkoutRequestId = (body as { Body: { stkCallback: { CheckoutRequestID: string } } })
      .Body.stkCallback.CheckoutRequestID

    const eventId = randomUUID()

    const { inserted, event } = await storage.insertEventIfAbsent({
      id: eventId,
      appId,
      checkoutRequestId,
      payload: body,
      status: 'PENDING',
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
    })

    if (!inserted) {
      // Safaricom sent this callback more than once. Common under load.
      logger?.warn('Duplicate callback received — already queued', {
        appId,
        checkoutRequestId,
        existingEventId: event.id,
        existingStatus: event.status,
      })
      return c.json({ ResultCode: 0, ResultDesc: 'Success' })
    }

    logger?.info('Callback queued for delivery', {
      eventId: event.id,
      appId,
      checkoutRequestId,
    })

    // ACK Safaricom first, then deliver asynchronously
    scheduleDelivery(event, relayApp, storage, logger)

    return c.json({ ResultCode: 0, ResultDesc: 'Success' })
  })

  // ---------------------------------------------------------------------------
  // GET /status/:checkoutRequestId — query delivery status
  // Query param: ?app_id=<appId>
  // ---------------------------------------------------------------------------

  app.get('/status/:checkoutRequestId', async (c) => {
    const { checkoutRequestId } = c.req.param()
    const appId = c.req.query('app_id')

    if (!appId) {
      return c.json({ error: 'app_id query parameter is required' }, 400)
    }

    const event = await storage.getEventByCheckoutId(checkoutRequestId, appId)

    if (!event) {
      return c.json({ error: 'No event found for this checkoutRequestId' }, 404)
    }

    return c.json({
      eventId: event.id,
      checkoutRequestId: event.checkoutRequestId,
      appId: event.appId,
      status: event.status,
      attemptCount: event.attemptCount,
      nextAttemptAt: event.nextAttemptAt?.toISOString() ?? null,
      lastError: event.lastError,
      createdAt: event.createdAt.toISOString(),
      deliveredAt: event.deliveredAt?.toISOString() ?? null,
    })
  })

  return app
}
