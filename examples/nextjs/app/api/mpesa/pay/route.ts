/**
 * POST /api/mpesa/pay
 *
 * Initiates an STK Push. Returns the paymentId your client can use to
 * poll GET /api/mpesa/status?id=<paymentId> for the result, or wait for
 * the onPaymentSettled handler to fire.
 *
 * Required env vars:
 *   MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE,
 *   MPESA_PASSKEY, MPESA_CALLBACK_URL, MPESA_ENVIRONMENT, DATABASE_URL
 */

import { NextRequest, NextResponse } from 'next/server'
import { mpesa } from '@/lib/mpesa'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { phoneNumber?: string; amount?: number; orderId?: string }

  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phoneNumber, amount, orderId } = body

  if (!phoneNumber || !amount || !orderId) {
    return NextResponse.json(
      { error: 'phoneNumber, amount, and orderId are required' },
      { status: 400 }
    )
  }

  try {
    const result = await mpesa.initiatePayment({
      phoneNumber,
      amount,
      accountReference: orderId,
      description:      `Payment for order ${orderId}`,
      // Using orderId as the idempotency key means a client retrying this
      // endpoint for the same order gets the existing payment back, not a
      // second STK Push to the customer's phone.
      idempotencyKey:   orderId,
    })

    return NextResponse.json({
      paymentId:         result.paymentId,
      checkoutRequestId: result.checkoutRequestId,
      message:           'STK Push sent. Customer will receive a prompt on their phone.',
    })
  } catch (err) {
    console.error('[mpesa] initiatePayment failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Payment initiation failed' },
      { status: 502 }
    )
  }
}
