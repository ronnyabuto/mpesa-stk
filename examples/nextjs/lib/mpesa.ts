/**
 * Shared MpesaStk singleton for Next.js.
 *
 * Import { mpesa } from '@/lib/mpesa' in any route handler.
 * Do not construct MpesaStk inside a route handler — you'll create a new
 * instance (and a new DB pool) on every request.
 *
 * MIGRATIONS
 * ----------
 * Call adapter.migrate() once on server startup — not here (module-level
 * code re-runs across serverless invocations). Use Next.js instrumentation:
 *
 *   // instrumentation.ts  (requires Next.js 14.1+ and experimental.instrumentationHook)
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') {
 *       const { adapter } = await import('./lib/mpesa')
 *       await adapter.migrate()
 *     }
 *   }
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { Pool } from 'pg'
import { MpesaStk, PostgresAdapter } from 'mpesa-stk'

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
export const adapter = new PostgresAdapter(pool)

export const mpesa = new MpesaStk(
  {
    consumerKey:    process.env['MPESA_CONSUMER_KEY']!,
    consumerSecret: process.env['MPESA_CONSUMER_SECRET']!,
    shortCode:      process.env['MPESA_SHORTCODE']!,
    passKey:        process.env['MPESA_PASSKEY']!,
    callbackUrl:    process.env['MPESA_CALLBACK_URL']!,
    environment:    (process.env['MPESA_ENVIRONMENT'] ?? 'sandbox') as 'sandbox' | 'production',
  },
  adapter
)

// Register handlers once, here — not in individual route files.
mpesa.onPaymentSettled(async (payment) => {
  // Update your order system when any payment reaches a terminal status.
  // This runs fire-and-forget after processCallback returns — it does not
  // block the HTTP response back to Safaricom.
  console.log('[mpesa] settled', payment.id, payment.status, payment.mpesaReceiptNumber)
  // e.g.: await db.orders.update({ where: { paymentId: payment.id }, data: { status: payment.status } })
})
