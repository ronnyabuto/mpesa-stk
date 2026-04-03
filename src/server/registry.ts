/**
 * PostgreSQL storage adapter for the relay service.
 *
 * Run migrate() once on startup. It is safe to call repeatedly — all DDL
 * uses IF NOT EXISTS.
 *
 * This adapter manages two tables that are separate from the mpesa_payments
 * table used by the core library:
 *
 *   relay_apps             — one row per registered application
 *   relay_delivery_events  — one row per Safaricom callback received
 *
 * The relay service does not touch mpesa_payments. It is purely a forwarding
 * layer: receive callback → validate → deduplicate → deliver to your app.
 */

import type { Pool } from 'pg'
import type { RelayApp, DeliveryEvent, DeliveryStatus, RelayStorage } from './types.js'

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface AppRow {
  app_id: string
  target_url: string
  signing_secret: string
  created_at: Date
}

interface EventRow {
  id: string
  app_id: string
  checkout_request_id: string
  payload: unknown
  status: string
  attempt_count: number
  next_attempt_at: Date | null
  last_error: string | null
  created_at: Date
  delivered_at: Date | null
}

const VALID_STATUSES = new Set<string>(['PENDING', 'DELIVERED', 'FAILED', 'DEAD'])

function rowToApp(row: AppRow): RelayApp {
  return {
    appId: row.app_id,
    targetUrl: row.target_url,
    signingSecret: row.signing_secret,
    createdAt: row.created_at,
  }
}

function rowToEvent(row: EventRow): DeliveryEvent {
  if (!VALID_STATUSES.has(row.status)) {
    throw new Error(
      `Unknown delivery status "${row.status}" for event "${row.id}". ` +
      'This indicates a database inconsistency.'
    )
  }
  return {
    id: row.id,
    appId: row.app_id,
    checkoutRequestId: row.checkout_request_id,
    payload: row.payload,
    status: row.status as DeliveryStatus,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PostgresRelayAdapter implements RelayStorage {
  constructor(private readonly pool: Pool) {}

  async createApp(app: Omit<RelayApp, 'createdAt'>): Promise<RelayApp> {
    const result = await this.pool.query<AppRow>(
      `INSERT INTO relay_apps (app_id, target_url, signing_secret)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [app.appId, app.targetUrl, app.signingSecret]
    )
    const row = result.rows[0]
    if (!row) throw new Error('INSERT into relay_apps returned no rows')
    return rowToApp(row)
  }

  async getApp(appId: string): Promise<RelayApp | null> {
    const result = await this.pool.query<AppRow>(
      'SELECT * FROM relay_apps WHERE app_id = $1 LIMIT 1',
      [appId]
    )
    const row = result.rows[0]
    return row ? rowToApp(row) : null
  }

  async updateAppTargetUrl(appId: string, targetUrl: string): Promise<void> {
    await this.pool.query(
      'UPDATE relay_apps SET target_url = $1 WHERE app_id = $2',
      [targetUrl, appId]
    )
  }

  async insertEventIfAbsent(
    event: Omit<DeliveryEvent, 'createdAt' | 'deliveredAt'>
  ): Promise<{ inserted: boolean; event: DeliveryEvent }> {
    // ON CONFLICT DO NOTHING handles the duplicate-callback case atomically.
    // If Safaricom fires the same callback twice, only one row is inserted.
    const result = await this.pool.query<EventRow>(
      `INSERT INTO relay_delivery_events
         (id, app_id, checkout_request_id, payload, status, attempt_count, next_attempt_at, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (app_id, checkout_request_id) DO NOTHING
       RETURNING *`,
      [
        event.id,
        event.appId,
        event.checkoutRequestId,
        JSON.stringify(event.payload),
        event.status,
        event.attemptCount,
        event.nextAttemptAt ?? null,
        event.lastError ?? null,
      ]
    )

    if (result.rows[0]) {
      return { inserted: true, event: rowToEvent(result.rows[0]) }
    }

    // Row already exists — return the existing event
    const existing = await this.getEventByCheckoutId(event.checkoutRequestId, event.appId)
    if (!existing) {
      throw new Error(
        `insertEventIfAbsent: conflict on (${event.appId}, ${event.checkoutRequestId}) ` +
        'but no existing row found. This should never happen.'
      )
    }
    return { inserted: false, event: existing }
  }

  async updateEvent(
    id: string,
    updates: Partial<Pick<DeliveryEvent, 'status' | 'attemptCount' | 'nextAttemptAt' | 'lastError' | 'deliveredAt'>>
  ): Promise<void> {
    const cols: Array<[string, unknown]> = []

    if ('status' in updates)        cols.push(['status', updates.status ?? null])
    if ('attemptCount' in updates)  cols.push(['attempt_count', updates.attemptCount ?? null])
    if ('nextAttemptAt' in updates) cols.push(['next_attempt_at', updates.nextAttemptAt ?? null])
    if ('lastError' in updates)     cols.push(['last_error', updates.lastError ?? null])
    if ('deliveredAt' in updates)   cols.push(['delivered_at', updates.deliveredAt ?? null])

    if (cols.length === 0) return

    const setClause = cols.map(([col], i) => `${col} = $${i + 1}`).join(', ')
    const values = cols.map(([, val]) => val)
    values.push(id)

    await this.pool.query(
      `UPDATE relay_delivery_events SET ${setClause} WHERE id = $${values.length}`,
      values
    )
  }

  async getEventByCheckoutId(checkoutRequestId: string, appId: string): Promise<DeliveryEvent | null> {
    const result = await this.pool.query<EventRow>(
      `SELECT * FROM relay_delivery_events
       WHERE checkout_request_id = $1 AND app_id = $2
       LIMIT 1`,
      [checkoutRequestId, appId]
    )
    const row = result.rows[0]
    return row ? rowToEvent(row) : null
  }

  async getDueEvents(): Promise<DeliveryEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT * FROM relay_delivery_events
       WHERE status IN ('PENDING', 'FAILED')
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
       ORDER BY created_at ASC
       LIMIT 500`,
    )
    return result.rows.map(rowToEvent)
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS relay_apps (
        app_id         TEXT PRIMARY KEY,
        target_url     TEXT NOT NULL,
        signing_secret TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS relay_delivery_events (
        id                   TEXT PRIMARY KEY,
        app_id               TEXT NOT NULL REFERENCES relay_apps(app_id),
        checkout_request_id  TEXT NOT NULL,
        payload              JSONB NOT NULL,
        status               TEXT NOT NULL DEFAULT 'PENDING'
                               CHECK (status IN ('PENDING','DELIVERED','FAILED','DEAD')),
        attempt_count        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at      TIMESTAMPTZ,
        last_error           TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at         TIMESTAMPTZ,
        UNIQUE (app_id, checkout_request_id)
      );

      CREATE INDEX IF NOT EXISTS relay_delivery_events_due
        ON relay_delivery_events (status, next_attempt_at)
        WHERE status IN ('PENDING', 'FAILED');
    `)
  }
}
