import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  verifyTimestampedWebhookSignature,
  verifyWebhookRequest,
  verifyWebhookSignature,
} from '../src/index'

const SIGNING_SECRET = 'whsec_test_secret'

const payload = {
  event: 'MESSAGE_RECEIVED',
  smsId: '65f0000000000000000000bb',
  sender: '+12025550123',
  message: 'hello',
}

/** Exactly how the api signs a delivery, so this asserts cross-implementation parity. */
function sign(body: unknown, secret = SIGNING_SECRET): string {
  return createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')
}

describe('verifyWebhookSignature', () => {
  it('accepts a signature produced the way the api produces it', async () => {
    const signature = sign(payload)

    await expect(
      verifyWebhookSignature({
        payload: JSON.stringify(payload),
        signature,
        signingSecret: SIGNING_SECRET,
      }),
    ).resolves.toBe(true)
  })

  it('accepts an object payload as a convenience', async () => {
    await expect(
      verifyWebhookSignature({
        payload,
        signature: sign(payload),
        signingSecret: SIGNING_SECRET,
      }),
    ).resolves.toBe(true)
  })

  it('accepts an uppercase hex signature', async () => {
    await expect(
      verifyWebhookSignature({
        payload,
        signature: sign(payload).toUpperCase(),
        signingSecret: SIGNING_SECRET,
      }),
    ).resolves.toBe(true)
  })

  it('rejects a tampered payload', async () => {
    const signature = sign(payload)

    await expect(
      verifyWebhookSignature({
        payload: { ...payload, message: 'tampered' },
        signature,
        signingSecret: SIGNING_SECRET,
      }),
    ).resolves.toBe(false)
  })

  it('rejects the wrong signing secret', async () => {
    await expect(
      verifyWebhookSignature({
        payload,
        signature: sign(payload, 'whsec_other_secret'),
        signingSecret: SIGNING_SECRET,
      }),
    ).resolves.toBe(false)
  })

  it('rejects a truncated, empty, or missing signature', async () => {
    const signature = sign(payload)

    await expect(
      verifyWebhookSignature({
        payload,
        signature: signature.slice(0, 32),
        signingSecret: SIGNING_SECRET,
      }),
    ).resolves.toBe(false)

    await expect(
      verifyWebhookSignature({ payload, signature: '', signingSecret: SIGNING_SECRET }),
    ).resolves.toBe(false)

    await expect(
      verifyWebhookSignature({ payload, signature, signingSecret: '' }),
    ).resolves.toBe(false)
  })
})

const NOW = 1_762_300_000
const rawBody = JSON.stringify({ ...payload, idempotencyKey: 'evt_1' })

/** Exactly how the api builds X-Textbee-Signature. */
function signTimestamped(body: string, t: number | string = NOW, secret = SIGNING_SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

function verify(signatureHeader: string, overrides: { payload?: string | Uint8Array; now?: number } = {}) {
  return verifyTimestampedWebhookSignature({
    payload: overrides.payload ?? rawBody,
    signatureHeader,
    signingSecret: SIGNING_SECRET,
    now: overrides.now ?? NOW,
  })
}

describe('verifyTimestampedWebhookSignature', () => {
  it('accepts a header produced the way the api produces it', async () => {
    await expect(verify(signTimestamped(rawBody))).resolves.toBe(true)
  })

  it('accepts a raw body as bytes', async () => {
    await expect(
      verify(signTimestamped(rawBody), { payload: Buffer.from(rawBody, 'utf8') }),
    ).resolves.toBe(true)
  })

  it('accepts a non-ASCII body', async () => {
    const body = JSON.stringify({ ...payload, message: 'café 👍' })
    await expect(verify(signTimestamped(body), { payload: body })).resolves.toBe(true)
  })

  it('rejects the wrong signing secret', async () => {
    await expect(
      verify(signTimestamped(rawBody, NOW, 'whsec_other_secret')),
    ).resolves.toBe(false)
  })

  it('rejects a tampered body', async () => {
    await expect(
      verify(signTimestamped(rawBody), { payload: rawBody.replace('hello', 'tampered') }),
    ).resolves.toBe(false)
  })

  it('rejects a timestamp older than 300 seconds and accepts one at the limit', async () => {
    const header = signTimestamped(rawBody)
    await expect(verify(header, { now: NOW + 300 })).resolves.toBe(true)
    await expect(verify(header, { now: NOW + 301 })).resolves.toBe(false)
  })

  it('rejects a timestamp too far in the future', async () => {
    const header = signTimestamped(rawBody)
    await expect(verify(header, { now: NOW - 300 })).resolves.toBe(true)
    await expect(verify(header, { now: NOW - 301 })).resolves.toBe(false)
  })

  it('honors a custom tolerance', async () => {
    await expect(
      verifyTimestampedWebhookSignature({
        payload: rawBody,
        signatureHeader: signTimestamped(rawBody),
        signingSecret: SIGNING_SECRET,
        toleranceSeconds: 10,
        now: NOW + 11,
      }),
    ).resolves.toBe(false)
  })

  it('rejects a timestamp re-signed under a different t', async () => {
    const v1 = signTimestamped(rawBody).split('v1=')[1]
    await expect(verify(`t=${NOW + 1},v1=${v1}`)).resolves.toBe(false)
  })

  it('rejects malformed headers', async () => {
    const v1 = signTimestamped(rawBody).split('v1=')[1]
    const malformed = [
      '',
      'garbage',
      `v1=${v1}`,
      `t=${NOW}`,
      `t=${NOW},v1=`,
      `t=-${NOW},v1=${v1}`,
      `t=${NOW}.5,v1=${v1}`,
      `t=abc,v1=${v1}`,
      `t=,v1=${v1}`,
    ]
    for (const header of malformed) {
      await expect(verify(header)).resolves.toBe(false)
    }
    await expect(
      verifyTimestampedWebhookSignature({
        payload: rawBody,
        signatureHeader: undefined,
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false)
  })

  it('accepts any matching v1 entry, in any position, and ignores unknown keys', async () => {
    const v1 = signTimestamped(rawBody).split('v1=')[1]
    const other = 'a'.repeat(64)
    await expect(verify(`t=${NOW},v1=${other},v1=${v1}`)).resolves.toBe(true)
    await expect(verify(`t=${NOW}, v1=${v1}, v1=${other}`)).resolves.toBe(true)
    await expect(verify(`t=${NOW},v0=${other},v1=${v1}`)).resolves.toBe(true)
    await expect(verify(`t=${NOW},v1=${other},v1=${other}`)).resolves.toBe(false)
  })

  it('rejects a duplicate t', async () => {
    const v1 = signTimestamped(rawBody).split('v1=')[1]
    await expect(verify(`t=${NOW},t=${NOW},v1=${v1}`)).resolves.toBe(false)
    await expect(verify(`t=${NOW},v1=${v1},t=${NOW - 1000}`)).resolves.toBe(false)
  })

  it('rejects a non-ASCII v1 without throwing', async () => {
    await expect(verify(`t=${NOW},v1=${'é'.repeat(64)}`)).resolves.toBe(false)
  })

  it('accepts an uppercase hex v1', async () => {
    const v1 = signTimestamped(rawBody).split('v1=')[1]!
    await expect(verify(`t=${NOW},v1=${v1.toUpperCase()}`)).resolves.toBe(true)
  })
})

describe('verifyWebhookRequest', () => {
  const legacySignature = createHmac('sha256', SIGNING_SECRET).update(rawBody).digest('hex')

  it('verifies X-Textbee-Signature from a plain headers object', async () => {
    await expect(
      verifyWebhookRequest({
        payload: rawBody,
        headers: { 'x-textbee-signature': signTimestamped(rawBody) },
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true)
  })

  it('matches header names case-insensitively', async () => {
    await expect(
      verifyWebhookRequest({
        payload: rawBody,
        headers: { 'X-TEXTBEE-SIGNATURE': signTimestamped(rawBody) },
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true)

    await expect(
      verifyWebhookRequest({
        payload: rawBody,
        headers: new Headers({ 'X-Textbee-Signature': signTimestamped(rawBody) }),
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true)
  })

  it('rejects a stale timestamped signature', async () => {
    await expect(
      verifyWebhookRequest({
        payload: rawBody,
        headers: { 'x-textbee-signature': signTimestamped(rawBody) },
        signingSecret: SIGNING_SECRET,
        now: NOW + 301,
      }),
    ).resolves.toBe(false)
  })

  it('ignores X-Signature by default', async () => {
    await expect(
      verifyWebhookRequest({
        payload: rawBody,
        headers: { 'x-signature': legacySignature },
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false)
  })

  it('falls back to X-Signature only when allowLegacy is true', async () => {
    await expect(
      verifyWebhookRequest({
        payload: Buffer.from(rawBody, 'utf8'),
        headers: { 'X-Signature': legacySignature },
        signingSecret: SIGNING_SECRET,
        allowLegacy: true,
      }),
    ).resolves.toBe(true)

    await expect(
      verifyWebhookRequest({
        payload: rawBody,
        headers: { 'x-signature': sign(payload, 'whsec_other_secret') },
        signingSecret: SIGNING_SECRET,
        allowLegacy: true,
      }),
    ).resolves.toBe(false)
  })

  it('does not fall back when X-Textbee-Signature is present but invalid', async () => {
    await expect(
      verifyWebhookRequest({
        payload: rawBody,
        headers: {
          'x-textbee-signature': signTimestamped(rawBody),
          'x-signature': legacySignature,
        },
        signingSecret: SIGNING_SECRET,
        now: NOW + 301,
        allowLegacy: true,
      }),
    ).resolves.toBe(false)
  })

  it('rejects a request with no signature headers', async () => {
    await expect(
      verifyWebhookRequest({
        payload: rawBody,
        headers: {},
        signingSecret: SIGNING_SECRET,
        allowLegacy: true,
      }),
    ).resolves.toBe(false)
  })
})
