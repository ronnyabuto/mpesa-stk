export interface RelayApp {
  appId: string
  targetUrl: string
  signingSecret: string
  createdAt: Date
}

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD'

export interface DeliveryEvent {
  id: string
  appId: string
  checkoutRequestId: string
  payload: unknown
  status: DeliveryStatus
  attemptCount: number
  nextAttemptAt: Date | null
  lastError: string | null
  createdAt: Date
  deliveredAt: Date | null
}

export interface RelayStorage {
  // App registry
  createApp(app: Omit<RelayApp, 'createdAt'>): Promise<RelayApp>
  getApp(appId: string): Promise<RelayApp | null>
  updateAppTargetUrl(appId: string, targetUrl: string): Promise<void>

  // Delivery events
  /**
   * Insert a delivery event only if no event already exists for this
   * (appId, checkoutRequestId) pair. Returns the event and whether it
   * was freshly inserted (false = duplicate callback from Safaricom).
   */
  insertEventIfAbsent(
    event: Omit<DeliveryEvent, 'createdAt' | 'deliveredAt'>
  ): Promise<{ inserted: boolean; event: DeliveryEvent }>

  updateEvent(
    id: string,
    updates: Partial<Pick<DeliveryEvent, 'status' | 'attemptCount' | 'nextAttemptAt' | 'lastError' | 'deliveredAt'>>
  ): Promise<void>

  getEventByCheckoutId(checkoutRequestId: string, appId: string): Promise<DeliveryEvent | null>

  /**
   * Return all events with status PENDING or FAILED whose nextAttemptAt
   * is at or before now. Used on startup to recover any attempts that were
   * scheduled when the server was last running.
   */
  getDueEvents(): Promise<DeliveryEvent[]>

  migrate(): Promise<void>
}

export interface RelayServerConfig {
  storage: RelayStorage
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void
    warn(msg: string, meta?: Record<string, unknown>): void
    error(msg: string, meta?: Record<string, unknown>): void
  }
}
