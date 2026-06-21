# Changelog

## [0.3.1] — 2026-06-21

Docs only — no code change.

- Trimmed the README (235 → 112 lines) to what/why/how/usage, grounded in the live-sandbox findings.
- Restored the reconciliation drift table, corrected: the "ghost credit" (your DB `SUCCESS`, Daraja has no record) and transient `4999`/`429` cases surface as `skipped`, not mismatches — `reconcile` never reports a status it can't read.
- Replaced the stale `~10 req/s` reconciliation rate-limit note with the observed Apigee SpikeArrest (5 req/60s, burst 1) and the `429` backoff behaviour.
- Fixed the documented poll schedule to match `pollIntervalMs`, and the dedup section now leads with the atomic CAS.
- Marked the STK Query endpoint path and rate limit as verified in sandbox; documented the `4999` transient code.

## [0.3.0] — 2026-06-21

Reliability fixes found by stress-testing against the live Daraja sandbox.

### Fixed

- **Concurrent same-key initiations no longer double-charge.** `initiatePayment` calls with the same `idempotencyKey` that race in the same process now share one in-flight STK Push instead of each sending their own. A double-tapped "Pay" or a retried request reaches Daraja once. (The old in-process `Set` guard never actually waited.)
- **Poll no longer marks pending payments FAILED on a transient query code.** The STK Query endpoint returns transient codes (e.g. `4999`, observed in sandbox) for a transaction that hasn't settled. The poll loop now settles only on a known-terminal code; `4999`, unrecognised codes, and `NaN` keep polling and resolve as `TIMEOUT`, which reconciliation then verifies.
- **Reconciliation backs off on rate limiting instead of skipping.** The STK Query endpoint is behind an Apigee SpikeArrest policy (5 req/60s, burst 1 in sandbox). A `429` now raises a typed `DarajaRateLimitError`; reconcile retries the same payment with exponential backoff (honouring `Retry-After`) rather than counting it as unverified.

### Changed

- **Phone validation restricted to Kenyan mobile prefixes** (`07x`, `010`, `011`). Non-mobile inputs (landline `02x`, common `05x`/`09x` typos) are rejected locally instead of being forwarded to Daraja to fail opaquely.
- **`pollIntervalMs` now drives the poll backoff.** It was documented but unused. The poll waits one interval before the first query, then a Fibonacci backoff (×1, 2, 3, 5, 8, 13, 21) capped at 30s — e.g. 5s → 10s → 15s → 25s → 30s at the default.

### Tests

- New coverage for the relay delivery engine (retry ladder, dead-lettering, outbound signing, restart recovery), webhook signature verification, true-concurrency dedup/idempotency, and real-world callback shapes (unordered metadata, string `TransactionDate`/`Amount`). 163 → 218 tests.

## [0.2.0] — 2026-04-03

### Added

- **Webhook relay server** (`mpesa-stk/server`) — the missing reliability layer between Safaricom and your app. Safaricom fires your `CallbackURL` once with no retry. The relay receives that callback, validates it, deduplicates it, persists it, and delivers it to your app with exponential-backoff retries (immediate → 30s → 2m → 10m → 30m → 2h → dead letter).

- `createRelayServer(config)` — returns a Hono app with four routes:
  - `POST /apps` — register an app, get back `appId` + `signingSecret`
  - `PATCH /apps/:appId` — update your target URL after a deploy
  - `POST /hooks/:appId` — point your Safaricom `CallbackURL` here
  - `GET /status/:checkoutRequestId?app_id=` — query delivery status

- `PostgresRelayAdapter` — relay storage over two new tables (`relay_apps`, `relay_delivery_events`). Completely separate from `mpesa_payments` — adopting the relay requires no schema changes to your existing setup.

- `recoverPendingDeliveries(storage)` — call on startup to reschedule any deliveries that were in-flight when the server last stopped. The `nextAttemptAt` column persists intent to Postgres so no delivery is permanently lost to a process restart.

- `signBody(body, secret)` / `verifySignature(body, secret, sig)` — HMAC-SHA256 signing helpers. The relay signs every outbound delivery; your app verifies it. Safaricom sends unsigned callbacks — without this, anyone who discovers your endpoint URL can POST fake success payloads.

- **Standalone binary** (`npx mpesa-stk-relay`) — run the relay as a self-contained process with `DATABASE_URL` and `PORT`. Migrates tables on startup, recovers in-flight deliveries, and runs a 60-second sweep interval as a backstop. Logs as newline-delimited JSON.

### Changed

- `tsup.config.ts` split into two build targets: library (ESM + CJS + types, Hono external) and binary (bundled CJS with shebang, pg external).
- `package.json` gains `bin.mpesa-stk-relay`, `exports["./server"]`, and `hono` + `@hono/node-server` as runtime dependencies.

### Notes

The core `MpesaStk` class, all adapters, and the full test suite are unchanged. This release is purely additive — existing integrations require no changes.

---

## [0.1.1] — 2026-03-26

### Fixed

- Corrected repository URL in `package.json` to `ronnyabuto/mpesa-stk`.
- Switched build tool to `tsup` for dual CJS + ESM output with proper `.d.ts` generation.

---

## [0.1.0] — 2026-03-24

### Added

- `MpesaStk` class — idempotent STK Push initiation, callback processing, polling fallback, reconciliation.
- `PostgresAdapter` — storage over `mpesa_payments` table with atomic `settlePayment` (compare-and-swap deduplication).
- `MemoryAdapter` — in-memory adapter for testing.
- Phone number normalisation accepting 6 input formats → `254xxxxxxxxx`.
- Result code mapping: `0` → SUCCESS, `1032` → CANCELLED, `1037` → TIMEOUT, `1019` → EXPIRED, others → FAILED. `TIMEOUT` is explicitly not a failure — money may have moved.
- Callback amount validation with ±1 KES tolerance.
- `StorageAdapter` interface for custom storage backends.
