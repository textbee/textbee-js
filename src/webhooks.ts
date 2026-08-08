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

/**
 * Check that a webhook really came from textbee.
 *
 * textbee signs deliveries with HMAC-SHA256 over the request body and sends the
 * hex digest in the `X-Signature` header. Comparison is constant time.
 */
export async function verifyWebhookSignature(
  options: VerifyWebhookSignatureOptions,
): Promise<boolean> {
  const { payload, signature, signingSecret } = options

  if (!signature || !signingSecret) {
    return false
  }

  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const expected = await hmacSha256Hex(signingSecret, body)

  return constantTimeEqual(expected, signature.toLowerCase())
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(message))

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
