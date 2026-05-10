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

  // In-process guard: prevents two concurrent initiations with the same idempotency
  // key from both hitting Daraja before either registers the key in storage.
  // Does not protect across separate processes — the UNIQUE DB constraint handles that.
  private readonly pendingIdempotencyKeys = new Set<string>()

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

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    const normalisedPhone = normalisePhoneNumber(params.phoneNumber)

    if (params.idempotencyKey) {
      // If another in-flight request is already processing this key, defer to storage.
      // This handles the in-process race; the DB UNIQUE constraint handles cross-process.
      if (this.pendingIdempotencyKeys.has(params.idempotencyKey)) {
        const existing = await this.storage.getPaymentByIdempotencyKey(params.idempotencyKey)
        if (existing) {
          this.logger?.info('Idempotent re-request (in-flight collision): returning existing payment', {
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

      this.pendingIdempotencyKeys.add(params.idempotencyKey)
    }

    try {
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

      // Key is passed directly to createPayment so it is stored in the same
      // atomic operation as the record — no crash window between two calls.
      await this.storage.createPayment(record, params.idempotencyKey)

      return { checkoutRequestId, merchantRequestId, paymentId }
    } finally {
      if (params.idempotencyKey) {
        this.pendingIdempotencyKeys.delete(params.idempotencyKey)
      }
    }
  }

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

  async reconcile(from: Date, to: Date): Promise<ReconciliationResult> {
    return _reconcile(from, to, this.config, this.storage, this.logger)
  }
}
