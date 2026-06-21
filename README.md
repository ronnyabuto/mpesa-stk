# mpesa-stk

TypeScript library for the M-Pesa STK Push lifecycle. Handles the parts the Daraja API leaves to you: idempotent initiation, atomic callback deduplication, polling fallback, and reconciliation.

---

## Why not the Daraja SDK directly?

The Daraja API gives you a way to send an STK Push and receive a callback. It leaves these to you:

- What to do when the callback never arrives (network failure, your server was restarting, Safaricom dropped it)
- How to handle Safaricom sending the same callback 2–4 times, which it does under load
- How to prevent double-charging when a client retries the initiation request
- How to detect when your database says `SUCCESS` but Safaricom has no record of it
- How to handle the phone number being masked in callbacks from 2026 onward

This library handles those. Neither it nor the relay handles B2C, C2B registration, balance queries, reversals, or any Daraja endpoint other than STK Push.

---

## Install

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
const result = await mpesa.reconcile(
  new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
  new Date(Date.now() -  5 * 60 * 1000)        // 5 minutes ago
)
```

Optional config: `timeoutMs` (default 75000), `pollIntervalMs` (default 5000), `maxPollAttempts` (default 10).

---

## How the hard parts work

### Callback deduplication — atomic CAS, not status checks

Safaricom fires the same callback 2–4 times under load. The naive fix (check `if status !== PENDING then skip`) has a race: two concurrent deliveries both read `PENDING`, both proceed, and `onPaymentSettled` fires twice.

`settlePayment` uses a database compare-and-swap instead:

```sql
UPDATE mpesa_payments
SET status = $1, ...
WHERE id = $2 AND status = 'PENDING'
```

Only one concurrent writer gets `rowCount = 1`. The loser gets `false` back and yields. `onPaymentSettled` fires exactly once — whether the race is callback vs. callback, callback vs. poll, or poll vs. poll.

### Idempotent initiation — two levels

`idempotencyKey` is guarded at two levels:

**In-process** — a `Set<string>` prevents two concurrent in-flight requests in the same process from both hitting the Daraja API before either has written to storage. The second caller waits for the first to finish, then finds the record already there.

**Cross-process** — `idempotency_key` has a `UNIQUE` database constraint. The key is written in the same `INSERT` as the payment record — no crash window between "STK Push sent" and "key registered". A process that crashes after `initiateStkPush` but before storage write will not leave an orphaned Daraja transaction with no idempotency key attached.

The in-process guard doesn't coordinate across Node.js processes — the DB constraint handles that.

### Poll fallback — Fibonacci schedule with storage short-circuit

The poll loop uses a Fibonacci backoff built from `pollIntervalMs` (default 5000 → 5s → 10s → 15s → 25s → 30s, capped at 30s) and checks storage at the top of every iteration — before issuing a Daraja query. If a callback arrived while the loop was sleeping, polling exits immediately without making a redundant API call.

When the poll loop finds a terminal state, it uses the same CAS as the callback path. If a late-arriving callback and an active poll both resolve in the same window, one wins atomically and the other yields and re-reads the winner's state.

### Reconciliation — all statuses, not just PENDING

Most reconciliation implementations only check `PENDING` payments. This library reconciles across every status, because drift runs in both directions:

| Stored | Daraja | What happened |
|--------|--------|---------------|
| `PENDING` | `SUCCESS` | Callback and polling both missed it — order not fulfilled, customer paid |
| `TIMEOUT` | `SUCCESS` | System gave up waiting but the customer paid — **most financially dangerous**: you may have already refunded them |
| `SUCCESS` | not found | Possible spoofed callback or ghost credit — escalate before taking any action |
| `FAILED` | `SUCCESS` | Payment wrote off as failed but money moved |

Mismatches are returned to the caller, not auto-corrected. Auto-correcting a `PENDING → SUCCESS` transition on a stale Daraja query response during a manual reversal would incorrectly credit an order. The library gives you the data; you decide what to do with each mismatch.

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

`TIMEOUT` means your system gave up waiting, not that the payment failed. Both paths use the same atomic CAS — whichever arrives first wins, the other yields. Run reconciliation to catch payments that settled after your polling window closed.

---

## Relay Server

Point Safaricom's `CallbackURL` at the relay instead of your app. The relay validates, deduplicates, persists, and delivers with exponential-backoff retries (immediate → 30s → 2m → 10m → 30m → 2h → dead-letter). Your app gets one signed webhook regardless of how many times Safaricom fires.

```
Safaricom → relay /hooks/<appId> → your app
                       ↑
              (retries if your app is down)
```

**Run standalone:**

```bash
DATABASE_URL=postgres://user:pass@host/db PORT=3000 npx mpesa-stk-relay
```

**Register your app** — returns `appId`, `signingSecret` (shown once), and the `hookUrl` to set as your Safaricom `CallbackURL`:

```bash
curl -X POST https://your-relay.com/apps \
  -H 'Content-Type: application/json' \
  -d '{ "targetUrl": "https://yourapp.com/mpesa/callback" }'
```

**Verify signatures in your app** — Safaricom doesn't sign its callbacks; the relay does. Skip this and anyone who knows your URL can POST fake success payloads:

```typescript
import { verifySignature } from 'mpesa-stk/server'

app.post('/mpesa/callback', (req, res) => {
  const body = JSON.stringify(req.body)
  const sig  = req.headers['x-mpesa-signature'] as string

  if (!verifySignature(body, process.env.MPESA_RELAY_SECRET!, sig)) {
    return res.status(401).end()
  }

  res.json({ ResultCode: 0, ResultDesc: 'Success' })
})
```

**Embed in an existing server** — `createRelayServer()` returns a [Hono](https://hono.dev/) app, mountable in Express, Cloudflare Workers, or Bun:

```typescript
import { createRelayServer, PostgresRelayAdapter, recoverPendingDeliveries } from 'mpesa-stk/server'
import { serve } from '@hono/node-server'

const storage = new PostgresRelayAdapter(new Pool({ connectionString: process.env.DATABASE_URL }))
await storage.migrate()

// Without this, retries scheduled before a server restart are lost.
// Scans for PENDING/FAILED events past their nextAttemptAt and reschedules them.
await recoverPendingDeliveries(storage)

serve({ fetch: createRelayServer({ storage }).fetch, port: 3000 })
```

**Check delivery status:**

```bash
curl 'https://your-relay.com/status/<checkoutRequestId>?app_id=<appId>'
```

Status values: `PENDING`, `DELIVERED`, `FAILED`, `DEAD`. `DEAD` means 6 attempts exhausted — check `lastError`.

---

## Docs

- [Why callbacks fail in production](./docs/why-callbacks-fail.md)
- [Reconciliation strategy](./docs/reconciliation.md)
- [Unverified Daraja behaviors](./tests/integration/UNVERIFIED_BEHAVIORS.md) — behaviors assumed by the library but not confirmed from official sources; corresponding tests are `it.todo` until confirmed

## Examples

- [Next.js App Router](./examples/nextjs/)
- [Express](./examples/express/server.ts)

---

MIT
