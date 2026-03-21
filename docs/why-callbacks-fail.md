# Why M-Pesa Callbacks Fail in Production

## The Short Version

The sandbox always delivers callbacks. Production does not. This document explains why, what breaks when callbacks don't arrive, and how `mpesa-stk` handles each failure mode.

---

## Why Callbacks Are Unreliable in Production

### 1. Safaricom-side infrastructure

Daraja's callback delivery is best-effort. Safaricom makes a single HTTP POST to your `CallBackURL` and does not retry on failure — if your server returns a non-200, times out, or is unreachable, the callback is simply dropped. There is no dead-letter queue, no retry schedule, no notification that the delivery failed.

This is not theoretical. Under load (especially during mobile money rushes — salary day, promotions, the end of the month), Daraja's outbound webhook infrastructure has been observed to:

- Drop callbacks silently
- Delay callbacks by several minutes
- Fire the same callback 2–4 times in rapid succession
- Deliver callbacks out of order relative to when transactions completed

### 2. Your server being down at callback time

The STK Push prompt appears on the customer's phone within seconds of initiation. The customer enters their PIN, and Safaricom processes the transaction. Your server may have restarted, deployed, or been unreachable in the 30–90 second window between initiation and callback.

Cloud environments (Vercel, Railway, Render free tier, App Engine) cold-start, scale to zero, or undergo deployments that can easily coincide with a callback delivery window.

### 3. Network path failures

Your `CallBackURL` traverses the public internet from Safaricom's data centres to your server. Any intermediate hop — DNS, CDN, load balancer, WAF, reverse proxy — can drop or reject the request. Common culprits:

- Cloudflare or AWS WAF rate-limiting Safaricom's IPs
- SSL certificate expiry on your callback endpoint
- TLS version mismatches (Safaricom's HTTP client has specific TLS requirements)
- Corporate firewalls blocking outbound connections from Safaricom

### 4. The sandbox never shows this

The Daraja sandbox is a simulation. It always delivers callbacks on a fast, reliable internal path. The latency is milliseconds, not seconds. There is no congestion, no retry failure, no cold start. **Any code that only works in the sandbox is not tested against production failure modes.**

This is the most dangerous assumption teams make. "It works in sandbox" means your happy path is correct, nothing more.

---

## What Breaks When Callbacks Don't Arrive

### Without deduplication

If you process every callback naively, a payment that Safaricom fires twice will:

- Credit the customer's order twice (if your handler creates credits)
- Trigger two fulfilment emails
- Cause a double-insert or double-update in your database, depending on your schema

This has a real monetary cost. You cannot rely on Safaricom not to send duplicates.

### Without polling fallback

If you wait for a callback that never arrives:

- Your order stays `PENDING` forever
- The customer paid but sees no confirmation
- Your support queue fills up with "I was charged but the order didn't go through"

### Without reconciliation

Even with polling, some edge cases produce drift:

- Your polling window expires (e.g. maxPollAttempts reached) and you mark the payment `TIMEOUT`, but Safaricom completed the transaction 3 minutes later
- Your DB update succeeded but the callback ACK timed out, so Safaricom retried the callback, which your server processed correctly — but your DB now shows `SUCCESS` while Safaricom's query API shows the original `CheckoutRequestID` in a different state

Reconciliation is the audit layer that catches what callbacks and polling both miss.

---

## The Polling Fallback Strategy

`mpesa-stk` starts a background polling loop after every STK Push initiation. The loop uses a Fibonacci-ish schedule to avoid hammering Daraja's query API while still catching results quickly:

```
Attempt:  1      2      3      4       5       6+
Delay:    3000   5000   8000   13000   21000   30000 ms
```

The loop stops when:

1. A real callback arrives (storage status changes from `PENDING`) — detected during the sleep between attempts
2. The STK Query API returns a non-zero ResultCode (terminal state)
3. `maxPollAttempts` is exhausted — payment is marked `TIMEOUT`

**Tradeoffs:**

- Polling adds Daraja API calls. The poll loop itself has no internal rate limiting — each `pollPaymentStatus` call runs its own Fibonacci schedule independently. If you're running many concurrent polls, you're making many concurrent STK Query requests. Know your Daraja tier's limits.
- `TIMEOUT` from polling does not mean the payment failed. It means your system gave up waiting. Reconciliation may later reveal the payment actually succeeded.
- The poll loop holds no server resources between attempts (it uses `setTimeout`). It is safe to run many concurrent polls from a memory standpoint.

---

## Deduplication Is Non-Negotiable

`mpesa-stk` deduplicates callbacks using the `CheckoutRequestID` field combined with the stored `status` field:

```
If stored status !== PENDING → this is a duplicate → return isDuplicate: true, do nothing
```

This check is O(1) against your storage adapter. The entire deduplication logic is in `callback.ts:processCallback`.

**Why not use `MerchantRequestID`?** Both IDs are present in the callback, but `CheckoutRequestID` is the more stable key — it is what the STK Query API also uses, making it the correct join key across the full lifecycle.

---

## The 5-Second Response Window

Safaricom's servers wait a maximum of **5 seconds** for your `CallBackURL` to respond. If you do not respond within 5 seconds, they may:

- Mark the delivery as failed
- Retry (depending on the Daraja version and endpoint type)
- In some cases, retry 2–3 more times over the following minutes

**Correct pattern:**

```typescript
// In your callback route handler:
res.json({ ResultCode: 0, ResultDesc: 'Success' }) // Send this FIRST

// Then process asynchronously:
mpesa.processCallback(body).then(...).catch(console.error)
```

`mpesa-stk` calls the `onPaymentSettled` handler inside `processCallback`, so if your handler is slow (sending emails, updating external systems), move the response above the `await`.

The library's own storage update (marking the payment as SUCCESS/FAILED/CANCELLED) is fast — typically a single indexed row update. The slow part is always user code.

---

## Callback Authentication: Unsigned Callbacks Are a Security Surface

Safaricom does not sign STK Push callbacks with an HMAC, JWT, or shared secret. This means **any HTTP client that knows your callback URL can POST a fake success callback.**

`processCallback` validates the structure of the payload and checks the `CheckoutRequestID` against your database, but it cannot cryptographically verify that a callback came from Safaricom.

**Recommended mitigations:**

1. **IP allowlisting** — Restrict your callback endpoint to Safaricom's published IP ranges at your WAF, CDN, or load balancer level. As of 2024, these are:
   ```
   196.201.214.200/28
   196.201.214.216/29
   196.201.214.232/30
   196.201.214.236/32
   196.201.214.238/32
   196.201.214.240/30
   196.201.214.244/32
   196.201.214.246/32
   ```
   Safaricom may update these ranges — verify against the Daraja portal documentation.

2. **Reconciliation** — Even if a spoofed callback writes a `SUCCESS` status to your database, scheduled reconciliation against the STK Query API will detect the drift (your DB says `SUCCESS`, Daraja has no record) and flag it as a mismatch.

3. **Keep the callback URL secret** — Do not publish it in client-side code, browser JavaScript, or public repositories. Use an unpredictable path (e.g., `/api/mpesa/callback/a3f9b2c4`).

---

## Polling Deduplication Does Not Work Across Serverless Invocations

The polling deduplication guard (`activePollIds`) is a module-level `Set` — it lives in process memory. In a **serverless environment** (Vercel, AWS Lambda, Google Cloud Functions), each function invocation is a separate process. The Set is empty on every cold start.

This means:
- If two concurrent Lambda invocations are triggered for the same `CheckoutRequestID`, **both will run independent poll loops**.
- Duplicate polling is harmless in terms of correctness (the storage adapter's `settlePayment` is atomic), but it doubles your Daraja API call count.

**If you are running in a serverless environment**, rely on the callback path (plus reconciliation) rather than polling. Polling is designed for long-running server processes. If you do poll from serverless, be aware that the in-process dedup has no effect across invocations.

---

## `rawCallback` Contains PII

The full M-Pesa callback body is stored as JSONB in the `raw_callback` column. This may contain:

- A (possibly masked) phone number
- A transaction date and amount
- An M-Pesa receipt number

This data is subject to data protection obligations depending on your jurisdiction (Kenya Data Protection Act 2019, GDPR if processing EU residents' data, etc.). You should:

- Apply appropriate database access controls to the `mpesa_payments` table
- Define a retention policy and purge `raw_callback` after the legally required period
- Disclose this storage in your privacy policy

---

## Masked Phone Numbers in 2026+

Starting in 2026, Safaricom masks the `PhoneNumber` field in the callback metadata:

```json
{ "Name": "PhoneNumber", "Value": "254708***430" }
```

In some cases the field is omitted entirely.

**This library never uses the phone number from the callback.** All state lookups are done exclusively via `CheckoutRequestID`. The original unmasked phone number saved during `initiatePayment` is never overwritten by callback processing.

If your application needs to display the customer's phone number, use the value stored at initiation time. This is the correct architecture regardless of masking — the callback is a state notification, not a source of truth for customer identity.
