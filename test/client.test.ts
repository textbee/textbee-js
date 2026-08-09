import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Textbee, TextbeeError } from '../src/index'

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

const API_KEY = 'test-api-key'
const DEVICE_ID = '65f0000000000000000000aa'

let fetchMock: ReturnType<typeof vi.fn>

// Built per call, never shared: a Response body can only be read once.
function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function lastCall() {
  const call = fetchMock.mock.calls.at(-1)
  if (!call) {
    throw new Error('fetch was not called')
  }
  const [url, init] = call as [URL, RequestInit]
  return {
    url: url.toString(),
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
  }
}

function client(options: { baseUrl?: string } = {}) {
  return new Textbee({ apiKey: API_KEY, ...options })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendSms', () => {
  it('posts the modern field names to the deviceless send endpoint', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: { successCount: 1 } }))

    await client().sendSms({
      message: 'Hello from textbee',
      recipients: ['+251912345678'],
    })

    const call = lastCall()
    expect(call.url).toBe('https://api.textbee.dev/api/v1/gateway/send-sms')
    expect(call.method).toBe('POST')
    expect(call.headers['x-api-key']).toBe(API_KEY)
    expect(call.body).toEqual({
      message: 'Hello from textbee',
      recipients: ['+251912345678'],
    })
    expect(call.body).not.toHaveProperty('smsBody')
    expect(call.body).not.toHaveProperty('receivers')
  })

  it('unwraps the queued response and keeps it narrowable', async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        data: {
          success: true,
          message: 'SMS added to queue for processing',
          smsBatchId: 'batch-1',
          recipientCount: 2,
        },
      }),
    )

    const result = await client().sendSms({
      message: 'queued',
      recipients: ['+251912345678', '+251912345679'],
    })

    expect('smsBatchId' in result).toBe(true)
    if ('smsBatchId' in result) {
      expect(result.smsBatchId).toBe('batch-1')
      expect(result.recipientCount).toBe(2)
    }
  })

  it('passes optional fields through and omits them entirely when unset', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: { successCount: 1 } }))

    await client().sendSms({
      message: 'with options',
      recipients: ['+251912345678'],
      deviceId: DEVICE_ID,
      simSubscriptionId: 2,
    })

    expect(lastCall().body).toEqual({
      message: 'with options',
      recipients: ['+251912345678'],
      deviceId: DEVICE_ID,
      simSubscriptionId: 2,
    })

    await client().sendSms({ message: 'bare', recipients: ['+251912345678'] })

    const keys = Object.keys(lastCall().body)
    expect(keys).not.toContain('deviceId')
    expect(keys).not.toContain('simSubscriptionId')
    expect(keys).not.toContain('scheduledAt')
  })

  it('serializes a Date scheduledAt and does not enforce the documented 72 hour maximum', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: { successCount: 1 } }))

    // Well beyond 72 hours. The maximum is documentation, not client validation,
    // so the SDK must forward it and let the API decide.
    const farFuture = new Date('2099-01-02T03:04:05.000Z')

    await client().sendSms({
      message: 'later',
      recipients: ['+251912345678'],
      scheduledAt: farFuture,
    })

    expect(lastCall().body.scheduledAt).toBe('2099-01-02T03:04:05.000Z')
  })
})

describe('errors', () => {
  it('maps a 400 body to TextbeeError', async () => {
    fetchMock.mockResolvedValue(
      respond(400, { success: false, error: 'Failed to send SMS' }),
    )

    await expect(
      client().sendSms({ message: 'x', recipients: ['+251912345678'] }),
    ).rejects.toMatchObject({
      name: 'TextbeeError',
      status: 400,
      message: 'Failed to send SMS',
    })
  })

  it('maps a 401 body to TextbeeError', async () => {
    fetchMock.mockImplementation(async () => respond(401, { error: 'Unauthorized' }))

    const error = await client()
      .getDevices()
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(TextbeeError)
    expect((error as TextbeeError).status).toBe(401)
    expect((error as TextbeeError).message).toBe('Unauthorized')
    expect((error as TextbeeError).body).toEqual({ error: 'Unauthorized' })
  })

  it('falls back to the status when the body carries no error text', async () => {
    fetchMock.mockImplementation(
      async () => new Response('<html>gateway</html>', { status: 502 }),
    )

    await expect(client().getDevices()).rejects.toMatchObject({
      status: 502,
      message: 'HTTP 502',
    })
  })
})

describe('telemetry headers', () => {
  it('identifies the sdk and its version on every request', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: [] }))

    await client().getDevices()

    const expected = `textbee-js/${pkg.version}`
    expect(lastCall().headers['user-agent']).toBe(expected)
    expect(lastCall().headers['x-sdk-client']).toBe(expected)
  })
})

describe('response envelopes', () => {
  it('returns getMessages as { data, meta } because it has no outer wrapper', async () => {
    // The response carries the direction uppercase while the query filter
    // below stays lowercase. That asymmetry is the API's, not a typo here.
    const page = {
      data: [{ _id: 'sms-1', message: 'hi', type: 'RECEIVED', status: 'received' }],
      meta: { page: 2, limit: 10, total: 11, totalPages: 2 },
    }
    fetchMock.mockImplementation(async () => respond(200, page))

    const result = await client().getMessages(DEVICE_ID, {
      type: 'received',
      page: 2,
      limit: 10,
      search: 'hi there',
    })

    expect(result).toEqual(page)

    const url = new URL(lastCall().url)
    expect(url.pathname).toBe(`/api/v1/gateway/devices/${DEVICE_ID}/messages`)
    expect(url.searchParams.get('type')).toBe('received')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.get('search')).toBe('hi there')
  })

  it('omits unset getMessages query params', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: [], meta: {} }))

    await client().getMessages(DEVICE_ID)

    expect(new URL(lastCall().url).search).toBe('')
  })

  it('routes the account-level getMessages overload to /gateway/messages', async () => {
    const page = {
      data: [
        {
          _id: 'sms-1',
          message: 'hi',
          type: 'RECEIVED',
          direction: 'received',
          status: 'received',
        },
      ],
      meta: { page: 1, limit: 50, total: 1, totalPages: 1, nextCursor: null, hasMore: false },
    }
    fetchMock.mockImplementation(async () => respond(200, page))

    const result = await client().getMessages({
      deviceIds: ['dev-a', 'dev-b'],
      smsBatchId: 'batch-1',
      direction: 'received',
      status: 'received',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: '2026-09-01T00:00:00Z',
      order: 'asc',
      limit: 50,
    })

    expect(result).toEqual(page)

    const url = new URL(lastCall().url)
    expect(url.pathname).toBe('/api/v1/gateway/messages')
    expect(url.searchParams.get('deviceIds')).toBe('dev-a,dev-b')
    expect(url.searchParams.get('smsBatchId')).toBe('batch-1')
    expect(url.searchParams.get('direction')).toBe('received')
    expect(url.searchParams.get('status')).toBe('received')
    // Dates serialize to the explicit-timezone form the API requires
    expect(url.searchParams.get('from')).toBe('2026-08-01T00:00:00.000Z')
    expect(url.searchParams.get('to')).toBe('2026-09-01T00:00:00Z')
    expect(url.searchParams.get('order')).toBe('asc')
    expect(url.searchParams.get('type')).toBeNull()
  })

  it('sends no query at all for a bare account-level getMessages()', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: [], meta: {} }))

    await client().getMessages()

    const url = new URL(lastCall().url)
    expect(url.pathname).toBe('/api/v1/gateway/messages')
    expect(url.search).toBe('')
  })

  it('iterateMessages follows nextCursor to the end and then stops', async () => {
    const pages = [
      {
        data: [{ _id: 'a' }, { _id: 'b' }],
        meta: { page: 1, limit: 2, total: 5, totalPages: 3, nextCursor: 'cur-1', hasMore: true },
      },
      {
        data: [{ _id: 'c' }, { _id: 'd' }],
        meta: { limit: 2, nextCursor: 'cur-2', hasMore: true },
      },
      {
        data: [{ _id: 'e' }],
        meta: { limit: 2, nextCursor: null, hasMore: false },
      },
    ]
    fetchMock.mockImplementation(async () => respond(200, pages[fetchMock.mock.calls.length - 1]))

    const seen: string[] = []
    for await (const message of client().iterateMessages({ order: 'asc' })) {
      seen.push(message._id)
    }

    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // First call opens without a cursor; later calls carry the returned one
    const cursors = fetchMock.mock.calls.map(
      (call) => new URL(String(call?.[0])).searchParams.get('cursor'),
    )
    expect(cursors).toEqual([null, 'cur-1', 'cur-2'])
  })

  it('iterateMessages stops early when the consumer breaks out', async () => {
    fetchMock.mockImplementation(async () =>
      respond(200, {
        data: [{ _id: 'a' }, { _id: 'b' }],
        meta: { limit: 2, nextCursor: 'cur-1', hasMore: true },
      }),
    )

    for await (const message of client().iterateMessages()) {
      void message
      break
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('unwraps the nested getSmsBatch envelope', async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        data: {
          batch: { _id: 'batch-1', successCount: 1, failureCount: 0 },
          messages: [{ _id: 'sms-1' }],
        },
      }),
    )

    const result = await client().getSmsBatch(DEVICE_ID, 'batch-1')

    expect(result.batch._id).toBe('batch-1')
    expect(result.messages).toHaveLength(1)
  })

  it('unwraps the plain { data } envelope for getSms and getDevice', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: { _id: 'sms-1', status: 'delivered' } }))
    await expect(client().getSms(DEVICE_ID, 'sms-1')).resolves.toMatchObject({
      status: 'delivered',
    })

    fetchMock.mockImplementation(async () => respond(200, { data: { _id: DEVICE_ID, enabled: true } }))
    await expect(client().getDevice(DEVICE_ID)).resolves.toMatchObject({
      _id: DEVICE_ID,
    })
  })

  it('posts to set-default without a body', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: { _id: DEVICE_ID, isDefault: true } }))

    const result = await client().setDefaultDevice(DEVICE_ID)

    expect(lastCall().method).toBe('POST')
    expect(lastCall().url).toBe(
      `https://api.textbee.dev/api/v1/gateway/devices/${DEVICE_ID}/set-default`,
    )
    expect(result.isDefault).toBe(true)
  })
})

describe('options', () => {
  it('strips trailing slashes from a custom baseUrl', async () => {
    fetchMock.mockImplementation(async () => respond(200, { data: [] }))

    await client({ baseUrl: 'http://localhost:3001/api/v1/' }).getDevices()

    expect(lastCall().url).toBe('http://localhost:3001/api/v1/gateway/devices')
  })

  it('rejects a missing apiKey', () => {
    expect(() => new Textbee({ apiKey: '' })).toThrow(TypeError)
    // @ts-expect-error exercising the runtime guard for untyped callers
    expect(() => new Textbee()).toThrow(TypeError)
  })
})
