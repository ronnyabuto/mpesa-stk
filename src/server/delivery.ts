import type { DeliveryEvent, RelayApp, RelayStorage, RelayServerConfig } from './types.js'
import { signBody } from './signing.js'

type Logger = RelayServerConfig['logger']

// ---------------------------------------------------------------------------
// Retry schedule
// ---------------------------------------------------------------------------

/**
 * Delay (in ms) before each retry attempt, indexed by attempt number.
 *
 * Attempt 0 = the first try (immediate, delay is 0 and ignored).
 * Attempt 1 = first retry, 30 seconds after failure.
 * Attempt 5 = last retry, 2 hours after the previous failure.
 * Attempt 6+ = no more retries; event is moved to DEAD.
 *
 * This mirrors what you'd expect from a production webhook service:
 * fast retries early (transient blips), slower retries later (server down).
 */
const RETRY_DELAYS_MS: number[] = [
  0,               // attempt 0: initial delivery
  30_000,          // attempt 1: 30s
  2 * 60_000,      // attempt 2: 2m
  10 * 60_000,     // attempt 3: 10m
  30 * 60_000,     // attempt 4: 30m
  2 * 3_600_000,   // attempt 5: 2h
]

const MAX_ATTEMPTS = RETRY_DELAYS_MS.length // 6 total attempts before dead-lettering

// ---------------------------------------------------------------------------
// Single delivery attempt
// ---------------------------------------------------------------------------

async function attempt(
  event: DeliveryEvent,
  app: RelayApp,
  storage: RelayStorage,
  logger?: Logger
): Promise<void> {
  const body = JSON.stringify(event.payload)
  const signature = signBody(body, app.signingSecret)
  const timestamp = String(Date.now())
  const nextAttemptCount = event.attemptCount + 1

  try {
    const res = await fetch(app.targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mpesa-Signature': signature,
        'X-Mpesa-Event-Id': event.id,
        'X-Mpesa-Timestamp': timestamp,
      },
      body,
      signal: AbortSignal.timeout(10_000), // 10s hard cutoff per attempt
    })

    if (res.ok) {
      await storage.updateEvent(event.id, {
        status: 'DELIVERED',
        attemptCount: nextAttemptCount,
        deliveredAt: new Date(),
        nextAttemptAt: null,
        lastError: null,
      })
      logger?.info('Delivered callback', {
        eventId: event.id,
        checkoutRequestId: event.checkoutRequestId,
        appId: event.appId,
        attempts: nextAttemptCount,
      })
      return
    }

    throw new Error(`Target returned HTTP ${res.status}`)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    if (nextAttemptCount >= MAX_ATTEMPTS) {
      await storage.updateEvent(event.id, {
        status: 'DEAD',
        attemptCount: nextAttemptCount,
        lastError: errorMsg,
        nextAttemptAt: null,
      })
      logger?.error('Delivery dead-lettered — exhausted retries', {
        eventId: event.id,
        checkoutRequestId: event.checkoutRequestId,
        appId: event.appId,
        attempts: nextAttemptCount,
        lastError: errorMsg,
      })
      return
    }

    const delayMs = RETRY_DELAYS_MS[nextAttemptCount] ?? 0
    const nextAttemptAt = new Date(Date.now() + delayMs)

    await storage.updateEvent(event.id, {
      status: 'FAILED',
      attemptCount: nextAttemptCount,
      lastError: errorMsg,
      nextAttemptAt,
    })

    logger?.warn('Delivery attempt failed — will retry', {
      eventId: event.id,
      checkoutRequestId: event.checkoutRequestId,
      appId: event.appId,
      attempt: nextAttemptCount,
      nextAttemptAt: nextAttemptAt.toISOString(),
      error: errorMsg,
    })

    // Schedule the retry in-process. If the server restarts before this fires,
    // the startup sweep (getDueEvents) will pick it up and reschedule it.
    setTimeout(() => {
      void runDelivery(event.id, storage, logger)
    }, delayMs)
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Load the latest event state from storage and attempt delivery.
 * Always reads fresh from storage so we have the current attempt count.
 */
async function runDelivery(
  eventId: string,
  storage: RelayStorage,
  logger?: Logger
): Promise<void> {
  const event = await storage.getDueEvents().then((events) =>
    events.find((e) => e.id === eventId)
  )

  if (!event) return // Already delivered or dead-lettered by another process

  const app = await storage.getApp(event.appId)
  if (!app) {
    logger?.error('Delivery skipped — app not found', { eventId, appId: event.appId })
    return
  }

  await attempt(event, app, storage, logger)
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Schedule an immediate first delivery attempt for a newly received callback.
 * Fire-and-forget — do not await this from a route handler.
 */
export function scheduleDelivery(
  event: DeliveryEvent,
  app: RelayApp,
  storage: RelayStorage,
  logger?: Logger
): void {
  void attempt(event, app, storage, logger)
}

/**
 * On server startup, scan for any events that were scheduled but not yet
 * delivered — either because the server was restarted mid-retry window or
 * because a previous delivery attempt didn't fire its setTimeout.
 *
 * Call this once during startup, after migrate().
 */
export async function recoverPendingDeliveries(
  storage: RelayStorage,
  logger?: Logger
): Promise<void> {
  const due = await storage.getDueEvents()

  if (due.length === 0) return

  logger?.info('Recovering delivery events from previous run', { count: due.length })

  for (const event of due) {
    const app = await storage.getApp(event.appId)
    if (!app) continue
    void attempt(event, app, storage, logger)
  }
}
