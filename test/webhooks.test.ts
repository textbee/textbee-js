import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyWebhookSignature } from '../src/index'

const SIGNING_SECRET = 'whsec_test_secret'

const payload = {
  event: 'MESSAGE_RECEIVED',
  smsId: '65f0000000000000000000bb',
  sender: '+251912345678',
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
