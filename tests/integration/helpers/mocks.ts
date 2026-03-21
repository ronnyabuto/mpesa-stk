/**
 * Mock factories for M-Pesa Daraja API responses.
 *
 * All shapes are based on the primary sources fetched during this session:
 *
 * STK Push initiation shapes:
 *   SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
 *   SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
 *
 * Callback shapes:
 *   SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
 *   SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
 *
 * STK Query shapes:
 *   SOURCE: https://dev.to/anne46/implementing-m-pesa-stk-push-and-query-in-ruby-on-rails-328d
 *
 * OAuth token shapes:
 *   SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
 *
 * ResultCode list:
 *   SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
 *   SOURCE: https://tuma.co.ke/common-mpesa-daraja-api-error-codes-explanation-and-mitigation/
 *   SOURCE: https://woodev.co.ke/common-m-pesa-api-errors/
 */

// ---------------------------------------------------------------------------
// OAuth token response
// SOURCE: https://dev.to/msnmongare/safaricom-daraja-api-authorization-api-guide-for-access-tokens-2kg1
// expires_in is documented as a string "3600", not a number.
// ---------------------------------------------------------------------------

export interface TokenResponseShape {
  access_token: string
  expires_in: string
}

export function mockTokenResponse(overrides: Partial<TokenResponseShape> = {}): TokenResponseShape {
  return {
    access_token: 'test-access-token-abc123xyz',
    expires_in: '3600',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// STK Push initiation — success response
// SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
// SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
// ResponseCode is a string. "0" means accepted.
// ---------------------------------------------------------------------------

export interface StkPushSuccessShape {
  MerchantRequestID: string
  CheckoutRequestID: string
  ResponseCode: string
  ResponseDescription: string
  CustomerMessage: string
}

export function mockStkPushSuccess(overrides: Partial<StkPushSuccessShape> = {}): StkPushSuccessShape {
  return {
    MerchantRequestID: '29115-34620561-1',
    CheckoutRequestID: 'ws_CO_191220191020363925',
    ResponseCode: '0',
    ResponseDescription: 'Success. Request accepted for processing',
    CustomerMessage: 'Success. Request accepted for processing',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// STK Push initiation — error response
// SOURCE: https://dev.to/msnmongare/m-pesa-express-stk-push-api-guide-40a2
// Error shape has errorCode and errorMessage fields (not ResponseCode).
// ---------------------------------------------------------------------------

export interface StkPushErrorShape {
  requestId: string
  errorCode: string
  errorMessage: string
}

export function mockStkPushError(
  errorCode: string = '400.002.02',
  errorMessage: string = 'Bad Request - Invalid BusinessShortCode'
): StkPushErrorShape {
  return {
    requestId: 'test-request-id-xyz',
    errorCode,
    errorMessage,
  }
}

// ---------------------------------------------------------------------------
// Callback — success (ResultCode 0)
// SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
// SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
//
// Key confirmed types:
//   ResultCode: number (0 for success)
//   Amount: number
//   TransactionDate: number (format: YYYYMMDDHHmmss e.g. 20241101102115)
//   PhoneNumber: number (e.g. 254708920430) — no + prefix, 12 digits
//
// Note on TransactionDate: bascil docs show number; mpesa-nextjs-docs shows
// string "YYYY-MM-DD HH:MM:SS" — the number form matches the official
// Safaricom sandbox example referenced in multiple sources.
// ---------------------------------------------------------------------------

export interface CallbackSuccessShape {
  Body: {
    stkCallback: {
      MerchantRequestID: string
      CheckoutRequestID: string
      ResultCode: 0
      ResultDesc: string
      CallbackMetadata: {
        Item: Array<{ Name: string; Value?: string | number }>
      }
    }
  }
}

export function mockCallbackSuccess(overrides: {
  checkoutRequestId?: string
  merchantRequestId?: string
  amount?: number
  receipt?: string
  transactionDate?: number
  phoneNumber?: number
} = {}): CallbackSuccessShape {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: overrides.merchantRequestId ?? '29115-34620561-1',
        CheckoutRequestID: overrides.checkoutRequestId ?? 'ws_CO_191220191020363925',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: overrides.amount ?? 100 },
            { Name: 'MpesaReceiptNumber', Value: overrides.receipt ?? 'NLJ7RT61SV' },
            { Name: 'TransactionDate', Value: overrides.transactionDate ?? 20191219102115 },
            { Name: 'PhoneNumber', Value: overrides.phoneNumber ?? 254708374149 },
          ],
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Callback — failure (any non-zero ResultCode)
// SOURCE: https://github.com/Bascil/mpesa-daraja-api-php/blob/master/docs/LipaNaMpesaOnline.md
// SOURCE: https://mpesa-nextjs-docs.vercel.app/handling-callback
//
// No CallbackMetadata present on failure callbacks.
// ResultCode is a number.
// ---------------------------------------------------------------------------

export interface CallbackFailureShape {
  Body: {
    stkCallback: {
      MerchantRequestID: string
      CheckoutRequestID: string
      ResultCode: number
      ResultDesc: string
    }
  }
}

export function mockCallbackFailure(
  resultCode: number = 1032,
  resultDesc: string = 'Request cancelled by user',
  overrides: { checkoutRequestId?: string; merchantRequestId?: string } = {}
): CallbackFailureShape {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: overrides.merchantRequestId ?? '29115-34620561-1',
        CheckoutRequestID: overrides.checkoutRequestId ?? 'ws_CO_191220191020363925',
        ResultCode: resultCode,
        ResultDesc: resultDesc,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// STK Query — still processing
// SOURCE: https://dev.to/anne46/implementing-m-pesa-stk-push-and-query-in-ruby-on-rails-328d
//
// When the transaction is still being processed, the query returns:
//   ResponseCode: "0" (request accepted)
//   ResultCode: "0" (string!) — this is the TYPE INCONSISTENCY documented in
//   developer reports. The query API returns ResultCode as a STRING, while the
//   callback delivers ResultCode as a NUMBER.
//
// ResultDesc "The service request is processed successfully." with ResultCode "0"
// during polling is AMBIGUOUS — it means the query was accepted, not that the
// payment succeeded. The package must continue polling in this state.
// ---------------------------------------------------------------------------

export interface StkQueryShape {
  ResponseCode: string
  ResponseDescription: string
  MerchantRequestID: string
  CheckoutRequestID: string
  ResultCode: string
  ResultDesc: string
}

export function mockStkQueryStillProcessing(
  checkoutRequestId: string = 'ws_CO_191220191020363925'
): StkQueryShape {
  return {
    ResponseCode: '0',
    ResponseDescription: 'The service request has been accepted successsfully',
    MerchantRequestID: '29115-34620561-1',
    CheckoutRequestID: checkoutRequestId,
    ResultCode: '0',
    ResultDesc: 'The service request is processed successfully.',
  }
}

export function mockStkQuerySuccess(
  checkoutRequestId: string = 'ws_CO_191220191020363925'
): StkQueryShape {
  return {
    ResponseCode: '0',
    ResponseDescription: 'The service request has been accepted successsfully',
    MerchantRequestID: '29115-34620561-1',
    CheckoutRequestID: checkoutRequestId,
    ResultCode: '0',
    ResultDesc: 'The service request is processed successfully.',
  }
}

export function mockStkQueryCancelled(
  checkoutRequestId: string = 'ws_CO_191220191020363925'
): StkQueryShape {
  return {
    ResponseCode: '0',
    ResponseDescription: 'The service request has been accepted successsfully',
    MerchantRequestID: '29115-34620561-1',
    CheckoutRequestID: checkoutRequestId,
    ResultCode: '1032',
    ResultDesc: 'Request cancelled by user',
  }
}

export function mockStkQueryFailed(
  resultCode: string,
  resultDesc: string,
  checkoutRequestId: string = 'ws_CO_191220191020363925'
): StkQueryShape {
  return {
    ResponseCode: '0',
    ResponseDescription: 'The service request has been accepted successsfully',
    MerchantRequestID: '29115-34620561-1',
    CheckoutRequestID: checkoutRequestId,
    ResultCode: resultCode,
    ResultDesc: resultDesc,
  }
}

// ---------------------------------------------------------------------------
// Helpers to build fetch mock that sequences multiple responses
// ---------------------------------------------------------------------------

/**
 * Build a mock fetch that returns: token response first, then the given API response.
 * Use vi.stubGlobal('fetch', makeTokenThenApiMock(...)) per test.
 */
export function makeTokenThenApiMock(
  apiResponseBody: unknown,
  apiStatus: number = 200
): typeof fetch {
  let callCount = 0
  return vi.fn().mockImplementation(() => {
    callCount++
    if (callCount === 1) {
      // Token request
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTokenResponse()),
        text: () => Promise.resolve(JSON.stringify(mockTokenResponse())),
      } as Response)
    }
    // STK Push / Query request
    return Promise.resolve({
      ok: apiStatus >= 200 && apiStatus < 300,
      status: apiStatus,
      json: () => Promise.resolve(apiResponseBody),
      text: () => Promise.resolve(JSON.stringify(apiResponseBody)),
    } as Response)
  })
}

import { vi } from 'vitest'
