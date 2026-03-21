# UNVERIFIED_BEHAVIORS.md

Behaviors reported by developers but not confirmed by any source fetched during this session.
These must NOT be encoded as passing tests until confirmed.

---

## 1. ResultCode 17 — Transaction Limit Exceeded

**Reported in:** Package source code (`src/callback.ts` comment line 28: `17   = Transaction limit exceeded`)
**Also mentioned in:** Not found in any fetched developer source.
**Status:** UNVERIFIED — present in package source comment but not confirmed by any developer doc fetched.
**Action needed:** Confirm from an official Safaricom source or from a developer who has observed ResultCode 17 in a real sandbox or production callback. Until confirmed, the package maps it to FAILED via the default case.
**Test file:** `tests/integration/result-codes.test.ts` — `it.todo`

---

## 2. Callback Retry Count and Interval

**Reported in:** General developer guidance states "if a response delays, mpesa api assumes it as failed and retries" (source: mpesa-nextjs-docs.vercel.app/handling-callback).
**Specific claim:** Multiple sources say retries happen but no source confirmed the exact number of retries (2? 3? unlimited?) or the exact retry interval.
**Status:** UNVERIFIED for exact retry count and interval.
**Action needed:** Confirm exact number of retry attempts and timing from an official Safaricom source or from a developer with production logs showing retry timing.
**Related tests:** `tests/integration/callback-edge-cases.test.ts` tests duplicate deduplication but NOT the exact retry timing.

---

## 3. TransactionDate as String vs Number in Callback

**Conflicting sources:**
- `https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md` — shows TransactionDate as **number** (e.g. `20191219102115`)
- `https://mpesa-nextjs-docs.vercel.app/handling-callback` — shows TransactionDate as **string** `"YYYY-MM-DD HH:MM:SS"` (e.g. `"2023-04-26 12:30:00"`)

**Status:** UNVERIFIED — two sources directly contradict each other. The package stores TransactionDate as-is in rawCallback and does not parse it, which is safe for both types.
**Action needed:** Confirm actual Daraja production behavior. The 14-digit number format (20191219102115) is more commonly cited across developer sources and matches the official sandbox example.

---

## 4. PhoneNumber Masking in 2026+ Callbacks

**Reported in:** Package source (callback.ts line 109): "PhoneNumber from callback is masked (e.g. 254708***430) or absent — DO NOT use it."
**Status:** The package already handles absent PhoneNumber in CallbackMetadata. However, the specific masking format `254708***430` was not confirmed from any fetched source.
**Action needed:** Confirm from a developer with 2025/2026 production Safaricom callback logs whether PhoneNumber is fully absent or present in masked form. The package handles both cases.

---

## 5. STK Push Initiated But No USSD Prompt Delivered to User

**Reported in:** Multiple developer guides note this scenario: API returns `ResponseCode: "0"` but user never sees the USSD prompt.
**Confirmed causes from sources:**
- Outdated SIM card (ResultCode 1037 eventually delivered in callback)
- Another transaction already in progress (ResultCode 1001)
- Device offline (ResultCode 1037)
**Unconfirmed:** Whether there is a specific ResultCode that uniquely identifies "API accepted, prompt never delivered" as distinct from 1037.
**Status:** PARTIALLY VERIFIED — 1037 covers the timeout case. No unique "prompt-not-delivered" code confirmed.

---

## 6. Concurrent Duplicate STK Push (Same Phone, Same Amount, Within Seconds)

**Reported in:** `https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md` — "Making multiple subsequent requests to the same phone number causes the initial request to timeout."
**Specific claim:** The first STK push becomes unresponsive even if the user enters the correct PIN.
**Status:** PARTIALLY VERIFIED — the production effect is confirmed by the PHP SDK docs. The exact ResultCode returned for the first request is not confirmed.
**Action needed:** Confirm whether the first request receives ResultCode 1001 (subscriber lock) or 1037 (timeout) or another code when a second STK is sent to the same number.

---

## 7. STK Query Endpoint Path

**Used in code:** `/mpesa/stkpushquery/v1/query`
**Status:** Not confirmed from any official doc fetched (developer.safaricom.co.ke was unreachable). Confirmed indirectly from package source. This path is widely used across open-source implementations.
**Action needed:** Confirm from official Safaricom docs when the portal becomes accessible.

---

## 8. Daraja Rate Limiting on STK Query

**Mentioned in:** Package source (reconcile.ts comment): "Caller should handle rate-limiting: Daraja has per-second query limits."
**Status:** UNVERIFIED — no specific rate limit number confirmed from any fetched source.
**Action needed:** Confirm exact rate limit (requests per second) from official Safaricom documentation.

---

## 9. OAuth Token — Grace Period After Expiry

**Reported in:** Not reported — this is a gap.
**Question:** Is there a grace period after the 3600s expiry during which an expired token still works?
**Status:** UNVERIFIED.
**Action needed:** Confirm whether Daraja accepts tokens for N seconds after official expiry.
The package applies a 60-second safety buffer (expires 60s early) to avoid hitting any boundary.
