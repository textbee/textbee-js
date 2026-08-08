export interface TextbeeOptions {
  /** API key from the textbee dashboard. Sent as the `x-api-key` header. */
  apiKey: string

  /** Override the API base URL. Defaults to `https://api.textbee.dev/api/v1`. */
  baseUrl?: string
}

export interface SendSmsRequest {
  /** The message body. */
  message: string

  /** Phone numbers to send to, in international format. */
  recipients: string[]

  /**
   * Which phone sends the message. Get ids from `getDevices()`.
   *
   * Omit it and textbee picks the sender for you: your default device first,
   * otherwise the enabled device with the most recent heartbeat. A malformed id
   * fails with 400 rather than falling back, so a typo cannot send from the
   * wrong phone.
   */
  deviceId?: string

  /**
   * Which SIM sends the message on a multi-SIM phone.
   *
   * This value is not validated. An id that does not match a SIM currently in
   * the phone is ignored, and the message goes out from the SIM configured in
   * the app's settings, or the system default. Nothing errors, so confirm the
   * SIM by checking which number the message arrived from.
   *
   * Find the id in the textbee Android app under Dashboard, "SIM Cards", where
   * each SIM shows its number with a copy button.
   */
  simSubscriptionId?: number

  /**
   * Send later instead of now, as an ISO 8601 string or a `Date`.
   *
   * Must be in the future, and up to 72 hours ahead. Omit for an immediate send.
   */
  scheduledAt?: string | Date
}

/** Returned when the message was accepted for delivery and queued. */
export interface SendSmsQueuedResponse {
  success: true
  message: string
  smsBatchId: string
  recipientCount: number
}

/** Returned when the message was dispatched to the device immediately. */
export interface SendSmsImmediateResponse {
  successCount: number
  [key: string]: unknown
}

/**
 * The send response shape depends on how the message was dispatched. Narrow it
 * with `'smsBatchId' in result` before reading batch fields.
 */
export type SendSmsResponse = SendSmsQueuedResponse | SendSmsImmediateResponse

export interface GetMessagesOptions {
  /** Filter by direction. Defaults to `all`. */
  type?: 'all' | 'sent' | 'received'

  /** 1-based page number. Defaults to 1. */
  page?: number

  /** Items per page. Defaults to 50, capped at 100 by the API. */
  limit?: number

  /** Free text match across the message body, recipient, and sender. */
  search?: string
}

export interface Device {
  _id: string
  name?: string
  brand?: string
  manufacturer?: string
  model?: string
  enabled: boolean
  isDefault: boolean
  lastHeartbeat?: string
  sentSMSCount: number
  receivedSMSCount: number
  os?: string
  osVersion?: string
  appVersionName?: string
  appVersionCode?: number
  createdAt?: string
  updatedAt?: string
}

export interface Message {
  _id: string
  message: string
  type: 'sent' | 'received'
  status:
    | 'pending'
    | 'dispatched'
    | 'sent'
    | 'delivered'
    | 'failed'
    | 'unknown'
    | 'received'
  sender?: string
  recipient?: string
  requestedAt?: string
  dispatchedAt?: string
  sentAt?: string
  deliveredAt?: string
  failedAt?: string
  receivedAt?: string
  errorCode?: string
  errorMessage?: string
  simSubscriptionId?: number
  smsBatch?: string
  createdAt?: string
  updatedAt?: string
}

export interface SmsBatch {
  _id: string
  message: string
  recipientCount: number
  recipientPreview?: string
  successCount: number
  failureCount: number
  status:
    | 'pending'
    | 'processing'
    | 'completed'
    | 'partial_success'
    | 'failed'
    | 'unknown'
  error?: string
  completedAt?: string
  createdAt?: string
  updatedAt?: string
}

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
}

export interface MessagesPage {
  data: Message[]
  meta: PaginationMeta
}

export interface SmsBatchResult {
  batch: SmsBatch
  messages: Message[]
}

/** Event names textbee sends in a webhook payload. */
export type WebhookEvent =
  | 'MESSAGE_RECEIVED'
  | 'MESSAGE_SENT'
  | 'MESSAGE_DELIVERED'
  | 'MESSAGE_FAILED'
  | 'UNKNOWN_STATE'
  | 'SMS_STATUS_UPDATED'
