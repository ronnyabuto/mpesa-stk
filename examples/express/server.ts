/**
 * Express example — mpesa-stk STK Push lifecycle
 *
 * Run:
 *   MPESA_CONSUMER_KEY=xxx \
 *   MPESA_CONSUMER_SECRET=xxx \
 *   MPESA_SHORTCODE=174379 \
 *   MPESA_PASSKEY=xxx \
 *   MPESA_CALLBACK_URL=https://yourserver.com/mpesa/callback \
 *   MPESA_ENVIRONMENT=sandbox \
 *   DATABASE_URL=postgres://user:pass@localhost/mydb \
 *   npx ts-node examples/express/server.ts
 *
 * Reconciliation:
 *   Schedule the /reconcile route (or a cron job) to run every 15 minutes
 *   for PENDING payments older than 5 minutes but newer than 24 hours.
 *   See docs/reconciliation.md.
 */

import express, { Request, Response } from 'express'
import { Pool } from 'pg'
import { MpesaStk, PostgresAdapter } from 'mpesa-stk'

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
const adapter = new PostgresAdapter(pool)

const mpesa = new MpesaStk(
  {
    consumerKey: process.env['MPESA_CONSUMER_KEY']!,
    consumerSecret: process.env['MPESA_CONSUMER_SECRET']!,
    shortCode: process.env['MPESA_SHORTCODE']!,
    passKey: process.env['MPESA_PASSKEY']!,
    callbackUrl: process.env['MPESA_CALLBACK_URL']!,
    environment: (process.env['MPESA_ENVIRONMENT'] ?? 'sandbox') as 'sandbox' | 'production',
  },
  adapter
)

// When a payment settles (SUCCESS / FAILED / CANCELLED / TIMEOUT / EXPIRED),
// update your own order system here.
mpesa.onPaymentSettled(async (payment) => {
  console.log('[mpesa] Payment settled:', payment.id, payment.status)
  // e.g.: await db.query('UPDATE orders SET status=$1 WHERE payment_id=$2', [payment.status, payment.id])
})

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())

/**
 * POST /mpesa/pay
 * Body: { phoneNumber: string, amount: number, orderId: string }
 */
app.post('/mpesa/pay', async (req: Request, res: Response) => {
  const { phoneNumber, amount, orderId } = req.body as {
    phoneNumber?: string
    amount?: number
    orderId?: string
  }

  if (!phoneNumber || !amount || !orderId) {
    res.status(400).json({ error: 'phoneNumber, amount, and orderId are required' })
    return
  }

  try {
    const result = await mpesa.initiatePayment({
      phoneNumber,
      amount,
      accountReference: orderId,
      description: `Payment for order ${orderId}`,
      idempotencyKey: orderId, // Prevents duplicate STK pushes on retry
    })

    res.json({
      paymentId: result.paymentId,
      checkoutRequestId: result.checkoutRequestId,
      message: 'STK Push sent. Customer will receive a prompt.',
    })
  } catch (err) {
    console.error('[mpesa] pay error:', err)
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Payment initiation failed',
    })
  }
})

/**
 * POST /mpesa/callback
 *
 * CRITICAL: Respond with { ResultCode: 0 } immediately.
 * Safaricom's servers time out after 5 seconds and will retry.
 * Do NOT do heavy work synchronously here — use onPaymentSettled above.
 */
app.post('/mpesa/callback', async (req: Request, res: Response) => {
  // Ack Safaricom first — always 200, always ResultCode 0
  res.json({ ResultCode: 0, ResultDesc: 'Success' })

  // Process asynchronously after the response has been sent
  try {
    const result = await mpesa.processCallback(req.body)
    console.log('[mpesa] callback processed:', result.paymentId, result.status, {
      isDuplicate: result.isDuplicate,
    })
  } catch (err) {
    console.error('[mpesa] callback processing error:', err)
    // Do NOT re-throw — the response is already sent
  }
})

/**
 * POST /mpesa/reconcile
 * Body: { from: ISO string, to: ISO string }
 *
 * Run this on a schedule (cron, Vercel Cron, etc.) rather than exposing
 * it as a public HTTP endpoint in production.
 */
app.post('/mpesa/reconcile', async (req: Request, res: Response) => {
  const { from, to } = req.body as { from?: string; to?: string }

  if (!from || !to) {
    res.status(400).json({ error: 'from and to (ISO date strings) are required' })
    return
  }

  try {
    const result = await mpesa.reconcile(new Date(from), new Date(to))
    res.json(result)
  } catch (err) {
    console.error('[mpesa] reconcile error:', err)
    res.status(500).json({ error: 'Reconciliation failed' })
  }
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env['PORT'] ?? 3000

// Run migrations before accepting traffic. Safe to call on every startup —
// all DDL uses IF NOT EXISTS so it's a no-op after the first run.
await adapter.migrate()

app.listen(PORT, () => {
  console.log(`[mpesa] Express server running on port ${PORT}`)
})
