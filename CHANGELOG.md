# Changelog

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
