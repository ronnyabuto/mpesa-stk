# mpesa-stk

TypeScript library for the M-Pesa STK Push lifecycle. Handles the parts the Daraja API leaves to you: idempotent initiation, atomic callback deduplication, polling fallback, and reconciliation.

**New in this version:** a built-in webhook relay server. Point your Safaricom `CallbackURL` at the relay, and it handles guaranteed delivery with exponential-backoff retries to your app — just like Stripe webhooks, but for Daraja.

---

## The problem

Safaricom fires your `CallbackURL` once. If your server is restarting, behind a CDN that rate-limits their IP, or just slow to respond — the callback is silently dropped. No retry, no dead-letter queue, no notification. You find out from a customer who says "I paid but nothing happened."

The polling fallback in `MpesaStk` catches a lot of that. But polling only works if your server is up. The relay catches what polling can't: the gap between when the callback was sent and when your server came back online.

---

## Installation

```bash
npm install mpesa-stk pg
```

Node.js 18+ required (uses native `fetch`).

---

## Quick Start — Library Mode

```typescript
import { MpesaStk, PostgresAdapter } from 'mpesa-stk'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PostgresAdapter(pool)

// Creates the mpesa_payments table if it doesn't exist. Safe to call on
// every startup — all DDL uses IF NOT EXISTS.
await adapter.migrate()

const mpesa = new MpesaStk(
  {
    consumerKey:    process.env.MPESA_CONSUMER_KEY!,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
    shortCode:      process.env.MPESA_SHORTCODE!,
    passKey:        process.env.MPESA_PASSKEY!,
    callbackUrl:    process.env.MPESA_CALLBACK_URL!,
    environment:    'sandbox',
  },
  adapter
)

// Fires when a payment reaches a terminal state — via callback or polling
mpesa.onPaymentSettled(async (payment) => {
  console.log(payment.id, payment.status, payment.mpesaReceiptNumber)
  // update your order system here
})

// Initiate — idempotencyKey prevents a double-charge if the request is retried
const payment = await mpesa.initiatePayment({
  phoneNumber:      '0712345678',
  amount:           500,
  accountReference: 'ORDER-123',
  description:      'Payment for order ORDER-123',
  idempotencyKey:   'ORDER-123',
})

// Callback route — respond to Safaricom before doing anything else
app.post('/mpesa/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Success' }) // must be within 5 seconds
  await mpesa.processCallback(req.body)
})

// Reconciliation — run on a schedule, not on every request
const reconciliation = await mpesa.reconcile(
  new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
  new Date(Date.now() -  5 * 60 * 1000)        // 5 minutes ago
)
```

---

## Relay Server Mode

Instead of pointing Safaricom's `CallbackURL` directly at your app, you point it at the relay. The relay validates the callback, deduplicates it, persists it, and then delivers it to your app with exponential-backoff retries. Your app gets the same signed webhook regardless of whether Safaricom fired once or four times.

```
Safaricom → relay /hooks/<appId> → your app POST /mpesa/callback
                       ↑
              (retries with backoff if your app is down)
```

### Run with Docker / standalone

```bash
DATABASE_URL=postgres://user:pass@host/db PORT=3000 npx mpesa-stk-relay
```

On first run it creates the `relay_apps` and `relay_delivery_events` tables automatically.

### Register your app

```bash
curl -X POST https://your-relay-domain.com/apps \
  -H 'Content-Type: application/json' \
  -d '{ "targetUrl": "https://yourapp.com/mpesa/callback" }'
```

Response:

```json
{
  "appId": "3f4a1c2d-...",
  "signingSecret": "a3f9b2c1...",
  "hookUrl": "/hooks/3f4a1c2d-...",
  "createdAt": "2026-04-03T10:00:00.000Z"
}
```

Store `signingSecret` somewhere safe — it's shown once. This is what you use to verify incoming webhooks and to update your target URL later.

Set your Safaricom `CallbackURL` to:

```
https://your-relay-domain.com/hooks/3f4a1c2d-...
```

### Verify webhook signatures in your app

Every delivery attempt includes an `X-Mpesa-Signature` header. Verify it before trusting the payload:

```typescript
import { verifySignature } from 'mpesa-stk/server'

app.post('/mpesa/callback', (req, res) => {
  const body = JSON.stringify(req.body) // or the raw body string
  const sig  = req.headers['x-mpesa-signature'] as string

  if (!verifySignature(body, process.env.MPESA_RELAY_SECRET!, sig)) {
    return res.status(401).end()
  }

  res.json({ ResultCode: 0, ResultDesc: 'Success' })
  // process the callback...
})
```

Safaricom does not sign its callbacks. The relay does. If you skip verification, anyone who discovers your callback URL can POST fake success payloads.

### Update your target URL

```bash
curl -X PATCH https://your-relay-domain.com/apps/3f4a1c2d-... \
  -H 'Authorization: Bearer <signingSecret>' \
  -H 'Content-Type: application/json' \
  -d '{ "targetUrl": "https://newapp.com/mpesa/callback" }'
```

### Check delivery status

```bash
curl 'https://your-relay-domain.com/status/ws_CO_050420261030...?app_id=3f4a1c2d-...'
```

Response:

```json
{
  "eventId": "...",
  "checkoutRequestId": "ws_CO_050420261030...",
  "status": "DELIVERED",
  "attemptCount": 2,
  "deliveredAt": "2026-04-03T10:01:35.000Z",
  "lastError": null
}
```

Possible `status` values: `PENDING`, `DELIVERED`, `FAILED`, `DEAD`.  
`DEAD` means the relay exhausted all 6 attempts — check `lastError` to see what your app was returning.

### Retry schedule

| Attempt | Delay after previous failure |
|---------|------------------------------|
| 1       | Immediate                    |
| 2       | 30 seconds                   |
| 3       | 2 minutes                    |
| 4       | 10 minutes                   |
| 5       | 30 minutes                   |
| 6       | 2 hours                      |
| —       | Dead-lettered                |

### Embed the relay in your own server

If you'd rather run the relay as part of an existing Node.js app instead of standalone:

```typescript
import { createRelayServer, PostgresRelayAdapter, recoverPendingDeliveries } from 'mpesa-stk/server'
import { serve } from '@hono/node-server'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const storage = new PostgresRelayAdapter(pool)

await storage.migrate()
await recoverPendingDeliveries(storage) // reschedule any in-flight retries

const relay = createRelayServer({ storage })

// Mount on any path you control
serve({ fetch: relay.fetch, port: 3000 })
```

The `createRelayServer()` function returns a [Hono](https://hono.dev/) app — you can mount it inside Express, serve it on Cloudflare Workers, or wrap it in Bun.

---

## Environment Variables

| Variable | Description |
|---|---|
| `MPESA_CONSUMER_KEY` | Daraja app consumer key |
| `MPESA_CONSUMER_SECRET` | Daraja app consumer secret |
| `MPESA_SHORTCODE` | Your M-Pesa shortcode (paybill or till number) |
| `MPESA_PASSKEY` | STK Push passkey from the Daraja portal |
| `MPESA_CALLBACK_URL` | Set this to your relay's `/hooks/<appId>` URL |
| `MPESA_ENVIRONMENT` | `sandbox` or `production` |
| `DATABASE_URL` | PostgreSQL connection string (relay server only) |
| `PORT` | Port for the relay server (default: 3000) |

The library itself does not read environment variables. Pass values explicitly.

---

## Database Setup

### Library tables (mpesa_payments)

Run this once before starting your server:

```sql
CREATE TABLE IF NOT EXISTS mpesa_payments (
  id                   TEXT PRIMARY KEY,
  checkout_request_id  TEXT UNIQUE NOT NULL,
  merchant_request_id  TEXT NOT NULL,
  phone_number         TEXT NOT NULL,
  amount               INTEGER NOT NULL,
  account_reference    TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','SUCCESS','FAILED','CANCELLED','TIMEOUT','EXPIRED')),
  mpesa_receipt_number TEXT,
  failure_reason       TEXT,
  result_code          INTEGER,
  initiated_at         TIMESTAMPTZ NOT NULL,
  completed_at         TIMESTAMPTZ,
  raw_callback         JSONB,
  idempotency_key      TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS mpesa_payments_status_initiated
  ON mpesa_payments(status, initiated_at);
```

Or call `await adapter.migrate()` on startup — it uses `IF NOT EXISTS` and is safe to call repeatedly.

### Relay tables (relay_apps, relay_delivery_events)

Created automatically when you run `await storage.migrate()` or start `npx mpesa-stk-relay`.

---

## Configuration

All fields in `MpesaConfig`:

| Field | Type | Default | Description |
|---|---|---|---|
| `consumerKey` | `string` | — | Daraja consumer key |
| `consumerSecret` | `string` | — | Daraja consumer secret |
| `shortCode` | `string` | — | Your M-Pesa shortcode |
| `passKey` | `string` | — | STK Push passkey |
| `callbackUrl` | `string` | — | Your callback endpoint (or relay hook URL) |
| `environment` | `'sandbox' \| 'production'` | — | Controls which Daraja URLs are used |
| `timeoutMs` | `number` | `75000` | HTTP timeout for all Daraja requests |
| `maxPollAttempts` | `number` | `10` | How many STK Query attempts before marking TIMEOUT |

---

## Payment Lifecycle

```
initiatePayment()
      │
      ▼
  [PENDING] ──────────────────────────────────────────────────────────┐
      │                                                                │
      │  callback arrives          poll finds terminal state          │
      ▼                                  ▼                            │
  [SUCCESS]                         [SUCCESS]                     maxPollAttempts
  [FAILED]                          [FAILED]                      exhausted
  [CANCELLED]                       [CANCELLED]                       │
  [EXPIRED]                         [EXPIRED]                         ▼
                                                                  [TIMEOUT]
```

`TIMEOUT` means your system gave up waiting, not that the payment failed. Run reconciliation — the customer may have paid after your polling window closed.

---

## Docs

- [Why callbacks fail in production](./docs/why-callbacks-fail.md)
- [Reconciliation strategy](./docs/reconciliation.md)

---

## Examples

- [Next.js App Router](./examples/nextjs/)
- [Express](./examples/express/server.ts)

---

## Why Not the Daraja SDK Directly?

The Daraja API gives you a way to send an STK Push and receive a callback. It leaves these to you:

- What to do when the callback never arrives (network failure, your server was restarting, Safaricom dropped it)
- How to handle Safaricom sending the same callback 2–4 times, which it does under load
- How to prevent double-charging when a client retries the initiation request
- How to detect when your database says `SUCCESS` but Safaricom has no record of it
- How to handle the phone number being masked in callbacks from 2026 onward

This library handles those. The relay server handles the delivery reliability layer on top of that. Neither handles B2C, C2B registration, balance queries, reversals, or any Daraja endpoint other than STK Push.

---

## License

MIT
