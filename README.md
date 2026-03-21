# mpesa-stk

TypeScript library for the M-Pesa STK Push lifecycle. Handles the parts the Daraja API leaves to you: idempotent initiation, atomic callback deduplication, polling fallback, and reconciliation.

---

## Installation

```bash
npm install mpesa-stk pg
```

Node.js 18+ required (uses native `fetch`).

---

## Quick Start

```typescript
import { MpesaStk, PostgresAdapter } from 'mpesa-stk'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const mpesa = new MpesaStk(
  {
    consumerKey:    process.env.MPESA_CONSUMER_KEY!,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
    shortCode:      process.env.MPESA_SHORTCODE!,
    passKey:        process.env.MPESA_PASSKEY!,
    callbackUrl:    process.env.MPESA_CALLBACK_URL!,
    environment:    'sandbox',
  },
  new PostgresAdapter(pool)
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

## Environment Variables

| Variable | Description |
|---|---|
| `MPESA_CONSUMER_KEY` | Daraja app consumer key |
| `MPESA_CONSUMER_SECRET` | Daraja app consumer secret |
| `MPESA_SHORTCODE` | Your M-Pesa shortcode (paybill or till number) |
| `MPESA_PASSKEY` | STK Push passkey from the Daraja portal |
| `MPESA_CALLBACK_URL` | Publicly reachable HTTPS URL that receives STK callbacks |
| `MPESA_ENVIRONMENT` | `sandbox` or `production` |

The library does not read environment variables directly. Pass values via `MpesaConfig`.

---

## Database Setup

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

---

## Configuration

All fields in `MpesaConfig`:

| Field | Type | Default | Description |
|---|---|---|---|
| `consumerKey` | `string` | — | Daraja consumer key |
| `consumerSecret` | `string` | — | Daraja consumer secret |
| `shortCode` | `string` | — | Your M-Pesa shortcode |
| `passKey` | `string` | — | STK Push passkey |
| `callbackUrl` | `string` | — | Your callback endpoint |
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

This library handles those. It does not handle B2C, C2B registration, balance queries, reversals, or any Daraja endpoint other than STK Push initiation and STK Push query.

---

## License

MIT
