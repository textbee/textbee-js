import { TextbeeError } from './errors'
import type {
  Device,
  IterateMessagesOptions,
  ListMessagesOptions,
  Message,
  MessageList,
  SendSmsRequest,
  SendSmsResponse,
  SmsBatchResult,
  TextbeeOptions,
} from './types'

const DEFAULT_BASE_URL = 'https://api.textbee.dev/api/v1'
const CLIENT_ID = `textbee-js/${__SDK_VERSION__}`

type QueryValue = string | number | undefined

interface RequestInit {
  query?: Record<string, QueryValue>
  body?: unknown
}

export class Textbee {
  readonly #apiKey: string
  readonly #baseUrl: string

  constructor(options: TextbeeOptions) {
    if (!options?.apiKey) {
      throw new TypeError('Textbee requires an apiKey')
    }

    this.#apiKey = options.apiKey
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
  }

  /** Send an SMS to one or more recipients. */
  async sendSms(request: SendSmsRequest): Promise<SendSmsResponse> {
    const body: Record<string, unknown> = {
      message: request.message,
      recipients: request.recipients,
    }

    if (request.deviceId !== undefined) {
      body.deviceId = request.deviceId
    }
    if (request.simSubscriptionId !== undefined) {
      body.simSubscriptionId = request.simSubscriptionId
    }
    if (request.scheduledAt !== undefined) {
      body.scheduledAt =
        request.scheduledAt instanceof Date
          ? request.scheduledAt.toISOString()
          : request.scheduledAt
    }

    const payload = await this.#request<{ data: SendSmsResponse }>(
      'POST',
      '/gateway/send-sms',
      { body },
    )
    return payload.data
  }

  /** List the devices registered to this account. */
  async getDevices(): Promise<Device[]> {
    const payload = await this.#request<{ data: Device[] }>(
      'GET',
      '/gateway/devices',
    )
    return payload.data
  }

  /** Fetch a single device by id. */
  async getDevice(deviceId: string): Promise<Device> {
    const payload = await this.#request<{ data: Device }>(
      'GET',
      `/gateway/devices/${encodeURIComponent(deviceId)}`,
    )
    return payload.data
  }

  /** Make a device the default sender for requests that omit `deviceId`. */
  async setDefaultDevice(deviceId: string): Promise<Device> {
    const payload = await this.#request<{ data: Device }>(
      'POST',
      `/gateway/devices/${encodeURIComponent(deviceId)}/set-default`,
    )
    return payload.data
  }

  /**
   * Page through the account's sent and received messages, filtered by
   * device, batch, direction, status, text, and time range.
   */
  async getMessages(options: ListMessagesOptions = {}): Promise<MessageList> {
    // The endpoint returns { data, meta } with no outer wrapper, so the whole
    // payload is the result.
    return await this.#request<MessageList>('GET', '/gateway/messages', {
      query: {
        deviceIds: options.deviceIds?.length
          ? options.deviceIds.join(',')
          : undefined,
        smsBatchId: options.smsBatchId,
        direction: options.direction,
        status: options.status,
        search: options.search,
        from: toIsoString(options.from),
        to: toIsoString(options.to),
        order: options.order,
        page: options.page,
        limit: options.limit,
        cursor: options.cursor,
      },
    })
  }

  /**
   * Iterate every message matching the filters, following the pagination
   * cursor until the end. `limit` is the page size, not a cap on the total.
   * Use `order: 'asc'` with a `from` bound to drain forward when polling.
   * `from` is inclusive, so a poll that resumes from the last `createdAt` sees
   * that message again; skip ids you have already handled.
   *
   * ```ts
   * for await (const message of textbee.iterateMessages({ direction: 'received' })) {
   *   handle(message)
   * }
   * ```
   */
  async *iterateMessages(
    options: IterateMessagesOptions = {},
  ): AsyncGenerator<Message, void, undefined> {
    let page = await this.getMessages(options)
    yield* page.data

    while (page.meta.nextCursor) {
      page = await this.getMessages({ ...options, cursor: page.meta.nextCursor })
      yield* page.data
    }
  }

  /** Fetch a single message, including its delivery status. */
  async getSms(deviceId: string, smsId: string): Promise<Message> {
    const payload = await this.#request<{ data: Message }>(
      'GET',
      `/gateway/devices/${encodeURIComponent(deviceId)}/sms/${encodeURIComponent(smsId)}`,
    )
    return payload.data
  }

  /**
   * Fetch a batch and every message in it, by the `smsBatchId` a send returns.
   * Needs the id of the device that sent the batch. When textbee picked the
   * device, use `getMessages({ smsBatchId })` instead.
   */
  async getSmsBatch(
    deviceId: string,
    smsBatchId: string,
  ): Promise<SmsBatchResult> {
    const payload = await this.#request<{ data: SmsBatchResult }>(
      'GET',
      `/gateway/devices/${encodeURIComponent(deviceId)}/sms-batch/${encodeURIComponent(smsBatchId)}`,
    )
    return payload.data
  }

  async #request<T>(
    method: string,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }

    const headers: Record<string, string> = {
      'x-api-key': this.#apiKey,
      'user-agent': CLIENT_ID,
      'x-sdk-client': CLIENT_ID,
      accept: 'application/json',
    }
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json'
    }

    const response = await fetch(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })

    const payload = await readBody(response)

    if (!response.ok) {
      throw new TextbeeError(response.status, errorMessage(payload, response.status), payload)
    }

    return payload as T
  }
}

/**
 * Resolve the API root from a base URL. A bare origin gets /api/v1, a path
 * containing /api/v1 is cut there, and any other path is kept as given for
 * proxies that map a prefix onto the API. Bad values throw rather than falling
 * back, so a typo never sends a self-hoster's key to the public API.
 */
function normalizeBaseUrl(raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) {
    return DEFAULT_BASE_URL
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new TypeError(
      `baseUrl is not a valid URL: ${JSON.stringify(value)}. Use your textbee api, ` +
        'for example https://sms.example.com. The /api/v1 suffix is added for you.',
    )
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`baseUrl must be http or https, got "${url.protocol}"`)
  }
  // textbee never uses basic auth, and https://api.textbee.dev@evil.com reads
  // like textbee while sending the key to evil.com.
  if (url.username || url.password) {
    throw new TypeError('baseUrl must not contain a username or password')
  }

  const segments = url.pathname.split('/').filter(Boolean)
  let cut = -1
  for (let i = segments.length - 2; i >= 0; i--) {
    if (
      segments[i]!.toLowerCase() === 'api' &&
      segments[i + 1]!.toLowerCase() === 'v1'
    ) {
      cut = i + 2
      break
    }
  }

  let path: string[]
  if (segments.length === 0) {
    path = ['api', 'v1']
  } else if (cut === -1) {
    path = segments
  } else {
    // Anything after /api/v1 is a route, not part of the root, so it is dropped.
    path = [...segments.slice(0, cut - 2), 'api', 'v1']
  }

  return [url.origin, ...path].join('/')
}

function toIsoString(value: string | Date | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : value
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    // Framework errors ({ statusCode, message, error }) carry the detail in
    // message, and error is only the reason phrase such as "Not Found".
    const keys = 'statusCode' in record ? ['message', 'error'] : ['error', 'message']
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value) {
        return value
      }
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === 'string')
      ) {
        return value.join('; ')
      }
    }
  }

  return `HTTP ${status}`
}
