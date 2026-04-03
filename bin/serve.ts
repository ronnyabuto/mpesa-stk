#!/usr/bin/env node
/**
 * mpesa-stk-relay — standalone webhook relay server
 *
 * Usage:
 *   DATABASE_URL=postgres://... PORT=3000 npx mpesa-stk-relay
 *
 * On first run the relay tables are created automatically. Point your Safaricom
 * CallbackURL at /hooks/<your-app-id> after registering via POST /apps.
 */

import { Pool } from 'pg'
import { serve } from '@hono/node-server'
import { createRelayServer } from '../src/server/relay.js'
import { PostgresRelayAdapter } from '../src/server/registry.js'
import { recoverPendingDeliveries } from '../src/server/delivery.js'

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  console.error('[mpesa-stk-relay] DATABASE_URL is required')
  process.exit(1)
}

const port = parseInt(process.env['PORT'] ?? '3000', 10)

const pool = new Pool({ connectionString: databaseUrl })

const storage = new PostgresRelayAdapter(pool)

// Structured enough to be useful without pulling in a logging library
const logger = {
  info:  (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ level: 'info',  msg, ...meta, ts: new Date().toISOString() })),
  warn:  (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ level: 'warn',  msg, ...meta, ts: new Date().toISOString() })),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: new Date().toISOString() })),
}

async function main() {
  // Run migrations first — safe to call on every startup
  await storage.migrate()
  logger.info('Database tables ready')

  // Reschedule any deliveries that were in-flight when the server last stopped
  await recoverPendingDeliveries(storage, logger)

  const app = createRelayServer({ storage, logger })

  serve({ fetch: app.fetch, port }, () => {
    logger.info(`mpesa-stk-relay listening`, { port })
    logger.info('Register an app via: POST /apps  { "targetUrl": "https://yourapp.com/mpesa/callback" }')
  })

  // Periodic sweep every 60 seconds to catch any events that slipped through
  // (e.g. if a setTimeout was lost due to a JS event loop anomaly)
  setInterval(() => {
    void recoverPendingDeliveries(storage, logger)
  }, 60_000)

  process.on('SIGTERM', async () => {
    logger.info('Shutting down')
    await pool.end()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('[mpesa-stk-relay] Fatal startup error:', err)
  process.exit(1)
})
