import { randomUUID } from 'crypto'
import type {
  MpesaConfig,
  InitiatePaymentParams,
  InitiatePaymentResult,
  CallbackProcessResult,
  ReconciliationResult,
  PaymentStatus,
  PaymentRecord,
  Logger,
} from './types.js'
import type { StorageAdapter } from './adapters/types.js'
import { normalisePhoneNumber, initiateStkPush } from './initiate.js'
import { processCallback as _processCallback } from './callback.js'
import { pollPaymentStatus as _pollPaymentStatus } from './poll.js'
import { reconcile as _reconcile } from './reconcile.js'

export class MpesaStk {
  private readonly config: Required<
    Pick<MpesaConfig, 'timeoutMs' | 'pollIntervalMs' | 'maxPollAttempts'>
  > &
    MpesaConfig

  private settledHandlers: Array<(payment: PaymentRecord) => void | Promise<void>> = []

  constructor(
    config: MpesaConfig,
    private readonly storage: StorageAdapter,
    private readonly logger?: Logger
  ) {
    this.config = {
      timeoutMs: 75000,
      pollIntervalMs: 5000,
      maxPollAttempts: 10,
      ...config,
    }
  }

  // ---------------------------------------------------------------------------
  // Register a handler that fires when any payment reaches a terminal status
  // ---------------------------------------------------------------------------

  onPaymentSettled(handler: (payment: PaymentRecord) => void | Promise<void>): void {
    this.settledHandlers.push(handler)
  }

  private async notifySettled(payment: PaymentRecord): Promise<void> {
    for (const handler of this.settledHandlers) {
      try {
        await handler(payment)
      } catch (err) {
        this.logger?.error('onPaymentSettled handler threw an error', {
          paymentId: payment.id,
          error: String(err),
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Initiate a payment
  // ---------------------------------------------------------------------------

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    const normalisedPhone = normalisePhoneNumber(params.phoneNumber)

    // Idempotency check — if a key is provided, look for an existing record first
    if (params.idempotencyKey) {
      const existing = await this.storage.getPaymentByIdempotencyKey(params.idempotencyKey)
      if (existing) {
        this.logger?.info('Idempotent re-request: returning existing payment', {
          idempotencyKey: params.idempotencyKey,
          paymentId: existing.id,
        })
        return {
          checkoutRequestId: existing.checkoutRequestId,
          merchantRequestId: existing.merchantRequestId,
          paymentId: existing.id,
        }
      }
    }

    const { merchantRequestId, checkoutRequestId } = await initiateStkPush(
      this.config,
      { ...params, normalisedPhone },
      this.logger
    )

    const paymentId = randomUUID()
    const record: PaymentRecord = {
      id: paymentId,
      checkoutRequestId,
      merchantRequestId,
      phoneNumber: normalisedPhone,
      amount: params.amount,
      accountReference: params.accountReference,
      status: 'PENDING',
      initiatedAt: new Date(),
    }

    await this.storage.createPayment(record)

    // Register idempotency key after successful persist
    if (params.idempotencyKey) {
      await this.storage.registerIdempotencyKey(params.idempotencyKey, paymentId)
    }

    return { checkoutRequestId, merchantRequestId, paymentId }
  }

  // ---------------------------------------------------------------------------
  // Process incoming callback from Safaricom
  // ---------------------------------------------------------------------------

  /**
   * Call this from your webhook route handler.
   * Always respond to Safaricom with `{ ResultCode: 0, ResultDesc: "Success" }`
   * immediately after this returns — Safaricom requires a 200 within 5 seconds.
   *
   * onPaymentSettled handlers are fired asynchronously after this method resolves
   * (fire-and-forget). They do NOT block the HTTP response. If you need to
   * guarantee handler completion before responding, call notifySettled yourself.
   */
  async processCallback(body: unknown): Promise<CallbackProcessResult> {
    const result = await _processCallback(body, this.storage, this.logger)

    // Only fire settled handlers for non-duplicate, terminal-status callbacks
    if (!result.isDuplicate && result.status !== 'PENDING') {
      const payment = await this.storage.getPayment(result.paymentId)
      if (payment) {
        // Fire-and-forget — the route handler should not await this
        void this.notifySettled(payment)
      }
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Manual poll trigger
  // ---------------------------------------------------------------------------

  async pollPaymentStatus(checkoutRequestId: string): Promise<PaymentStatus> {
    return _pollPaymentStatus(
      checkoutRequestId,
      this.config,
      this.storage,
      async (payment) => {
        await this.notifySettled(payment)
      },
      this.logger
    )
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  async reconcile(from: Date, to: Date): Promise<ReconciliationResult> {
    return _reconcile(from, to, this.config, this.storage, this.logger)
  }
}
