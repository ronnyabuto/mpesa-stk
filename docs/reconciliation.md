# Reconciliation

## What Is Reconciliation Drift?

Reconciliation drift is when your database disagrees with Safaricom's records about the state of a transaction.

Common scenarios:

**Your DB says `SUCCESS`, Safaricom says it never completed.**
This happens when:
- A callback spoofing attack wrote a fake SUCCESS to your database (if you weren't validating)
- A bug in your callback handler wrote SUCCESS before fully verifying the result code
- You processed a callback for the wrong `CheckoutRequestID`

**Your DB says `PENDING`, Safaricom says `SUCCESS`.**
This happens when:
- Your server was down when the callback arrived and polling also failed
- The payment completed after your polling window expired
- Your `CallBackURL` was misconfigured and callbacks went somewhere else

**Your DB says `TIMEOUT`, Safaricom says `SUCCESS`.**
This is the most financially painful scenario. The customer paid. Your system gave up waiting. They never got their goods. Your support team eventually refunds them. Later, reconciliation shows Safaricom completed the payment — you've now given a free refund.

---

## When to Run Reconciliation

Run reconciliation on a schedule, not on-demand. Recommended cadence:

```
Every 15 minutes, for payments:
  - initiated more than 5 minutes ago (STK is still active for ~60s, give it buffer)
  - initiated less than 24 hours ago (older payments are unlikely to change state)
```

Concrete date range example:

```typescript
// Run every 15 minutes via cron
const now = new Date()
const to = new Date(now.getTime() - 5 * 60 * 1000)       // 5 minutes ago
const from = new Date(now.getTime() - 24 * 60 * 60 * 1000) // 24 hours ago

const result = await mpesa.reconcile(from, to)
```

### Understanding `checked` vs. `skipped`

`ReconciliationResult` contains three counts:

| Field | Meaning |
|---|---|
| `checked` | Payments successfully queried against Daraja. These are either matched or have a mismatch. |
| `matched` | Payments where your DB status agrees with Daraja. |
| `skipped` | Payments where the Daraja STK Query API returned an error. These were NOT verified and are NOT counted in `checked`. |

**Important:** If you see `checked: 47` but you had 50 payments in the date range, the difference may be 3 skipped payments — not 3 matched payments. Always log `skipped` separately and re-run reconciliation for the same window if `skipped > 0`.

Skipped payments are logged at the `ERROR` level with the payment ID and error detail.

---

**Why 5 minutes minimum age?** The STK prompt is active for approximately 60 seconds. After the customer enters their PIN, Safaricom's backend may take additional seconds to finalize. Polling handles the 0–5 minute window. Reconciliation handles everything that slipped through.

**Why 24 hours maximum age?** Beyond 24 hours, PENDING payments almost certainly represent abandoned transactions or system bugs, not legitimate payments in flight. You should have a separate process for investigating stale PENDING records.

---

## How to Run It

```typescript
import { MpesaStk, PostgresAdapter } from 'mpesa-stk'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const mpesa = new MpesaStk(config, new PostgresAdapter(pool))

// Run on a schedule (node-cron, Vercel Cron, AWS EventBridge, etc.)
async function runReconciliation() {
  const now = new Date()
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const to   = new Date(now.getTime() -  5 * 60 * 1000)

  const result = await mpesa.reconcile(from, to)

  // checked = payments successfully queried against Daraja
  // skipped = payments where the Daraja query API returned an error (not counted in checked)
  console.log(
    `Reconciliation: checked=${result.checked} matched=${result.matched} skipped=${result.skipped}`
  )

  if (result.skipped > 0) {
    console.warn(`${result.skipped} payments could not be verified — re-run reconciliation for this window`)
  }

  if (result.mismatches.length > 0) {
    console.warn('MISMATCHES FOUND:', result.mismatches)
    // Alert your team — see "What to Do With Mismatches" below
  }
}
```

---

## What to Do With Mismatches

**`mpesa-stk` does NOT auto-correct mismatches.** This is intentional.

Auto-correction sounds appealing but is dangerous:
- A mismatch between your DB and Daraja could mean your DB is wrong, or Daraja's query API is returning stale data, or the transaction is genuinely in an ambiguous intermediate state
- Auto-correcting `PENDING → SUCCESS` on a mismatch could credit an order before a manual reversal has been processed
- Auto-correcting `SUCCESS → FAILED` could cancel a fulfilled order

The recommended process for each mismatch:

1. **Alert your team** (PagerDuty, Slack, email) with the full `ReconciliationMismatch` object
2. **Cross-check** the `MpesaReceiptNumber` in Daraja's query response against the Safaricom M-Pesa Portal (business.safaricom.co.ke) for the authoritative source
3. **If your DB says `PENDING` and Daraja confirms `SUCCESS`**: manually update your DB and fulfil the order, then investigate why the callback/poll missed it
4. **If your DB says `SUCCESS` and Daraja does not recognise the transaction**: escalate to Safaricom support before taking any action — this may indicate a security incident

### Mismatch severity tiers

| Stored | Daraja | Severity | Action |
|--------|--------|----------|--------|
| PENDING | SUCCESS | High | Order not fulfilled, customer paid — fix immediately |
| PENDING | FAILED | Low | Payment didn't go through, order correctly unprocessed |
| SUCCESS | FAILED | Critical | Possible fraud or system bug — escalate to Safaricom |
| TIMEOUT | SUCCESS | High | Customer paid, system gave up — investigate polling config |

---

## Rate Limiting

`mpesa-stk` makes one STK Query API call per payment during reconciliation, with a 100ms pause between each query. That keeps throughput around 10 req/s, which stays below Safaricom's documented limits for most tiers.

If your tier has a lower limit, or you're reconciling a large backlog, run reconciliation in smaller date range windows rather than one large pass. A date range covering 500 payments will take ~50 seconds at 100ms intervals; a 24-hour window with normal transaction volume is usually fine.

---

## Reconciliation vs. the M-Pesa Portal

Reconciliation via the STK Query API is fast and programmatic but has limits:

- The query API returns the current state, which may be slightly stale during high load
- For official financial reconciliation (end-of-month, tax, audit), use the Daraja Transaction Status API or download the merchant statement from the M-Pesa business portal

`mpesa-stk`'s reconciliation is an operational tool, not a financial audit trail. For compliance purposes, the business portal statement is the authoritative record.
