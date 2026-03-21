import type {
  PaymentStatus,
  PaymentRecord,
  CallbackProcessResult,
  MpesaCallbackBody,
  MpesaStkCallbackSuccess,
  Logger,
} from './types.js'
import type { StorageAdapter } from './adapters/types.js'
import {
  validateCallbackStructure,
  validateCallbackAmount,
  extractMetadataValue,
} from './validate.js'

// ---------------------------------------------------------------------------
// ResultCode → PaymentStatus mapping
// ---------------------------------------------------------------------------

/**
 * Map Daraja STK Push result codes to internal payment statuses.
 *
 * ResultCode reference:
 *  0    = Success
 *  1    = Insufficient funds
 *  17   = Transaction limit exceeded
 *  1019 = Transaction expired
 *  1032 = Cancelled by user
 *  1037 = Timeout — user didn't respond
 *  2001 = Wrong PIN entered
 */
export function resultCodeToStatus(code: number): PaymentStatus {
  switch (code) {
    case 0:    return 'SUCCESS'
    case 1032: return 'CANCELLED'
    case 1037: return 'TIMEOUT'
    case 1019: return 'EXPIRED'
    default:   return 'FAILED'
  }
}

// ---------------------------------------------------------------------------
// Main callback processor
// ---------------------------------------------------------------------------

export async function processCallback(
  body: unknown,
  storage: StorageAdapter,
  logger?: Logger
): Promise<CallbackProcessResult> {
  // 1. Structural validation — throws on malformed input
  if (!validateCallbackStructure(body)) {
    throw new Error(
      'Invalid callback structure: missing required fields (Body.stkCallback.{MerchantRequestID,CheckoutRequestID,ResultCode,ResultDesc})'
    )
  }

  const validated = body as MpesaCallbackBody
  const cb = validated.Body.stkCallback

  logger?.info('Received STK callback', {
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
  })

  // 2. Look up the payment — use CheckoutRequestID as the ONLY lookup key.
  //    NEVER use the phone number from the callback: Safaricom masks it in 2026+.
  const payment = await storage.getPaymentByCheckoutId(cb.CheckoutRequestID)

  if (!payment) {
    throw new Error(
      `No payment found for CheckoutRequestID "${cb.CheckoutRequestID}". ` +
      'This may be a callback for a transaction initiated outside this library.'
    )
  }

  // 3. Deduplication — a non-PENDING status means we already processed this.
  //    Return early without touching the record or firing any handler.
  if (payment.status !== 'PENDING') {
    logger?.warn('Duplicate callback received — ignoring', {
      paymentId: payment.id,
      checkoutRequestId: cb.CheckoutRequestID,
      existingStatus: payment.status,
    })
    const dupResult: CallbackProcessResult = {
      paymentId: payment.id,
      status: payment.status,
      isDuplicate: true,
    }
    if (payment.mpesaReceiptNumber !== undefined) {
      dupResult.receipt = payment.mpesaReceiptNumber
    }
    return dupResult
  }

  const status = resultCodeToStatus(cb.ResultCode)
  const now = new Date()

  if (cb.ResultCode === 0) {
    // Success path
    const successCb = cb as MpesaStkCallbackSuccess
    const items = successCb.CallbackMetadata.Item

    const amount = extractMetadataValue(items, 'Amount') as number | undefined
    const receipt = extractMetadataValue(items, 'MpesaReceiptNumber') as string | undefined
    // TransactionDate is a number like 20241101102115 — store as-is for audit
    const transactionDate = extractMetadataValue(items, 'TransactionDate')
    // PhoneNumber from callback is masked (e.g. 254708***430) or absent — DO NOT use it.
    // We intentionally leave payment.phoneNumber unchanged (the original unmasked value).

    // Amount validation — allow ±1 KES tolerance
    if (amount !== undefined && !validateCallbackAmount(payment.amount, amount)) {
      throw new Error(
        `Callback amount mismatch: expected ${payment.amount} KES, received ${amount} KES ` +
        `for CheckoutRequestID "${cb.CheckoutRequestID}". ` +
        'Difference exceeds ±1 KES tolerance. Investigate before accepting.'
      )
    }

    logger?.info('STK callback — payment succeeded', {
      paymentId: payment.id,
      receipt,
      transactionDate,
    })

    const updateFields: Partial<PaymentRecord> = {
      status: 'SUCCESS',
      completedAt: now,
      rawCallback: body,
      // phoneNumber deliberately NOT updated here
    }
    if (receipt !== undefined) {
      updateFields.mpesaReceiptNumber = receipt
    }

    // Atomic compare-and-swap: only succeeds if payment is still PENDING.
    // Returns false if a concurrent callback already settled this payment.
    const claimed = await storage.settlePayment(payment.id, updateFields)
    if (!claimed) {
      logger?.warn('Duplicate callback lost race — ignored (atomic dedup)', {
        paymentId: payment.id,
        checkoutRequestId: cb.CheckoutRequestID,
      })
      const current = await storage.getPayment(payment.id)
      const dupResult: CallbackProcessResult = {
        paymentId: payment.id,
        status: current?.status ?? 'SUCCESS',
        isDuplicate: true,
      }
      if (current?.mpesaReceiptNumber !== undefined) {
        dupResult.receipt = current.mpesaReceiptNumber
      }
      return dupResult
    }

    const successResult: CallbackProcessResult = {
      paymentId: payment.id,
      status: 'SUCCESS',
      isDuplicate: false,
    }
    if (receipt !== undefined) {
      successResult.receipt = receipt
    }
    return successResult
  } else {
    // Failure path
    logger?.warn('STK callback — payment not successful', {
      paymentId: payment.id,
      resultCode: cb.ResultCode,
      resultDesc: cb.ResultDesc,
    })

    // Atomic compare-and-swap for failure path as well
    const claimed = await storage.settlePayment(payment.id, {
      status,
      failureReason: cb.ResultDesc,
      resultCode: cb.ResultCode,
      completedAt: now,
      rawCallback: body,
    })
    if (!claimed) {
      logger?.warn('Duplicate callback (failure) lost race — ignored (atomic dedup)', {
        paymentId: payment.id,
        checkoutRequestId: cb.CheckoutRequestID,
      })
      const current = await storage.getPayment(payment.id)
      return {
        paymentId: payment.id,
        status: current?.status ?? status,
        isDuplicate: true,
      }
    }

    return {
      paymentId: payment.id,
      status,
      isDuplicate: false,
    }
  }
}
