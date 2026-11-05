/** Default maximum distance, in seconds, between a signed timestamp and now. */
const DEFAULT_TOLERANCE_SECONDS = 300

const encoder = new TextEncoder()

export interface VerifyWebhookSignatureOptions {
  /**
   * The webhook request body. Prefer the raw body string.
   *
   * An object works too, but only because parsing and re-serializing usually
   * preserves key order. Frameworks that rebuild the body can break that, so
   * read the raw body when your server makes it available.
   */
  payload: string | object

  /** Value of the `X-Signature` request header. */
  signature: string

  /** Signing secret shown with the webhook subscription in the dashboard. */
  signingSecret: string
}

export interface VerifyTimestampedWebhookSignatureOptions {
  /** The raw request body, exactly as received. Do not parse and re-serialize it. */
  payload: string | Uint8Array

  /** Value of the `X-Textbee-Signature` request header: `t=<unix seconds>,v1=<hex>`. */
  signatureHeader: string | null | undefined

  /** Signing secret shown with the webhook subscription in the dashboard. */
  signingSecret: string

  /** Maximum difference, in seconds, between the signed timestamp and now. Defaults to 300. */
  toleranceSeconds?: number

  /** Current time in unix seconds. Defaults to the system clock. */
  now?: number
}

/** Request headers as a Fetch `Headers` object or a plain object such as Node's `req.headers`. */
export type WebhookRequestHeaders =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>

export interface VerifyWebhookRequestOptions {
  /** The raw request body, exactly as received. Do not parse and re-serialize it. */
  payload: string | Uint8Array

  /** The request headers. Names are matched case-insensitively. */
  headers: WebhookRequestHeaders

  /** Signing secret shown with the webhook subscription in the dashboard. */
  signingSecret: string

  /** Maximum difference, in seconds, between the signed timestamp and now. Defaults to 300. */
  toleranceSeconds?: number

  /** Current time in unix seconds. Defaults to the system clock. */
  now?: number

  /**
   * Accept the `X-Signature` header when `X-Textbee-Signature` is absent.
   * Off by default, because `X-Signature` has no replay protection. Turn it on
   * only for old receivers that cannot read the signature header yet.
   */
  allowLegacy?: boolean
}

/**
 * Check that a webhook really came from textbee, using the `X-Signature` header.
 *
 * textbee signs deliveries with HMAC-SHA256 over the request body and sends the
 * hex digest in the `X-Signature` header. Comparison is constant time.
 *
 * @deprecated This header has no timestamp, so a captured delivery can be
 * replayed. textbee still sends it, so this keeps working. Use
 * {@link verifyWebhookRequest} or {@link verifyTimestampedWebhookSignature}.
 */
export async function verifyWebhookSignature(
  options: VerifyWebhookSignatureOptions,
): Promise<boolean> {
  const { payload, signature, signingSecret } = options

  if (!signature || !signingSecret) {
    return false
  }

  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const expected = await hmacSha256Hex(signingSecret, encoder.encode(body))

  return constantTimeEqual(expected, signature.toLowerCase())
}

/**
 * Check the timestamped signature in the `X-Textbee-Signature` header.
 *
 * The header is `t=<unix seconds>,v1=<hex>`, where the hex value is
 * HMAC-SHA256 over `<t>.<raw body>`. Any matching `v1` entry passes. Returns
 * false when the header is malformed, no `v1` entry matches, or `t` is more
 * than `toleranceSeconds` away from now in either direction.
 */
export async function verifyTimestampedWebhookSignature(
  options: VerifyTimestampedWebhookSignatureOptions,
): Promise<boolean> {
  const {
    payload,
    signatureHeader,
    signingSecret,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    now = Math.floor(Date.now() / 1000),
  } = options

  const body = toBytes(payload)
  if (!signatureHeader || !signingSecret || !body) {
    return false
  }

  const parsed = parseSignatureHeader(signatureHeader)
  if (!parsed) {
    return false
  }

  // Written as a negated <= so a NaN tolerance or clock rejects instead of passing.
  if (!(Math.abs(now - Number(parsed.timestamp)) <= toleranceSeconds)) {
    return false
  }

  const prefix = encoder.encode(`${parsed.timestamp}.`)
  const signed = new Uint8Array(prefix.length + body.length)
  signed.set(prefix)
  signed.set(body, prefix.length)

  const expected = await hmacSha256Hex(signingSecret, signed)

  let matched = false
  for (const candidate of parsed.signatures) {
    if (constantTimeEqual(expected, candidate.toLowerCase())) {
      matched = true
    }
  }

  return matched
}

/**
 * Check that a webhook request came from textbee, from its headers.
 *
 * Verifies the timestamped signature in `X-Textbee-Signature`. When that
 * header is absent and `allowLegacy` is true, falls back to `X-Signature`,
 * which has no replay protection.
 */
export async function verifyWebhookRequest(
  options: VerifyWebhookRequestOptions,
): Promise<boolean> {
  const { payload, headers, signingSecret, toleranceSeconds, now, allowLegacy = false } = options

  const signatureHeader = getHeader(headers, 'x-textbee-signature')
  if (signatureHeader !== undefined) {
    return verifyTimestampedWebhookSignature({
      payload,
      signatureHeader,
      signingSecret,
      toleranceSeconds,
      now,
    })
  }

  if (!allowLegacy) {
    return false
  }

  const legacySignature = getHeader(headers, 'x-signature')
  const body = toBytes(payload)
  if (!legacySignature || !signingSecret || !body) {
    return false
  }

  const expected = await hmacSha256Hex(signingSecret, body)

  return constantTimeEqual(expected, legacySignature.toLowerCase())
}

function parseSignatureHeader(
  header: string,
): { timestamp: string; signatures: string[] } | null {
  let timestamp: string | undefined
  const signatures: string[] = []

  for (const part of header.split(',')) {
    const separator = part.indexOf('=')
    if (separator === -1) {
      continue
    }

    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()

    if (key === 't') {
      if (timestamp !== undefined || !/^\d+$/.test(value)) {
        return null
      }
      timestamp = value
    } else if (key === 'v1' && value) {
      signatures.push(value)
    }
  }

  if (timestamp === undefined || signatures.length === 0) {
    return null
  }

  return { timestamp, signatures }
}

function getHeader(headers: WebhookRequestHeaders, name: string): string | undefined {
  if (typeof headers.get === 'function') {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined
  }

  // Every case variant counts, so a second copy of a header cannot hide behind the first.
  const values: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined) {
      values.push(...(Array.isArray(value) ? value : [value]))
    }
  }

  return values.length > 0 ? values.join(',') : undefined
}

function toBytes(payload: unknown): Uint8Array | undefined {
  if (typeof payload === 'string') {
    return encoder.encode(payload)
  }
  // A body parser that skipped the request can leave undefined or {} here.
  return payload instanceof Uint8Array ? payload : undefined
}

async function hmacSha256Hex(secret: string, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  // Copied so a view over a SharedArrayBuffer or a larger Buffer pool is safe to sign.
  const digest = await crypto.subtle.sign('HMAC', key, new Uint8Array(message))

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }

  return mismatch === 0
}
