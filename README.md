# @textbee/sdk

[![npm](https://img.shields.io/npm/v/@textbee/sdk)](https://www.npmjs.com/package/@textbee/sdk)
[![CI](https://github.com/textbee/textbee-js/actions/workflows/ci.yaml/badge.svg)](https://github.com/textbee/textbee-js/actions/workflows/ci.yaml)
[![license](https://img.shields.io/npm/l/@textbee/sdk)](./LICENSE)

Official JavaScript SDK for [textbee.dev](https://textbee.dev), the open source SMS gateway that turns an Android phone into an SMS API.

Zero dependencies, TypeScript types included, works in Node 18+, Bun, Deno, Cloudflare Workers, and Vercel Edge.

## Install

```bash
npm install @textbee/sdk
```

```bash
pnpm add @textbee/sdk
```

## Quickstart

Get an API key from the [textbee dashboard](https://textbee.dev/dashboard), then:

```js
import { Textbee } from '@textbee/sdk'

const textbee = new Textbee({ apiKey: process.env.TEXTBEE_API_KEY })

await textbee.sendSms({
  recipients: ['+12025550123'],
  message: 'Hello from textbee!',
})
```

## Send options

`sendSms` needs only `message` and `recipients`. Everything else is optional.

| Option | Type | What it does |
| --- | --- | --- |
| `deviceId` | `string` | Which phone sends the message. Omit it and textbee uses your default device, or the enabled device with the most recent heartbeat. |
| `simSubscriptionId` | `number` | Which SIM sends the message on a multi-SIM phone. Omit it and the phone uses its configured preferred SIM, or the system default. |
| `scheduledAt` | `string \| Date` | Send later instead of now. ISO 8601 or a `Date`, must be in the future, up to 72 hours ahead. |

```js
await textbee.sendSms({
  recipients: ['+12025550123'],
  message: 'Your appointment is tomorrow at 9am',
  deviceId: '65f0000000000000000000aa',
  simSubscriptionId: 2,
  scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
})
```

### Finding your simSubscriptionId

Open the textbee Android app, go to **Dashboard**, and find the **SIM Cards** section. Each SIM shows its subscription id with a copy button.

Be aware that this value is not validated. If the id does not match a SIM currently in the phone it is ignored, and the message goes out from the preferred or default SIM instead. Nothing errors, so confirm which SIM was used by checking the number the message arrived from.

## Devices

```js
const devices = await textbee.getDevices()
const device = await textbee.getDevice(deviceId)

// Change which device handles sends that omit deviceId
await textbee.setDefaultDevice(deviceId)
```

## Messages and delivery status

History is account-level: one call covers every device, and `deviceIds` narrows it.

```js
// Paginated history across the whole account, filterable and searchable
const { data, meta } = await textbee.getMessages({
  direction: 'received', // 'all' | 'sent' | 'received'
  deviceIds: [deviceId], // omit for every device
  status: 'delivered', // delivery state; direction=sent + status=failed lists failed sends
  search: 'invoice',
  from: '2026-08-01', // dates are UTC; datetimes need an explicit timezone
  to: '2026-09-01T00:00:00Z', // exclusive, so windows never double-count
  page: 1,
  limit: 50,
})

// direction on each message is lowercase and feeds straight back into filters
data.filter((m) => m.direction === 'received')

// Which recipients of a bulk send failed: filter by the batch a send returned
const { smsBatchId } = await textbee.sendSms({ recipients, message })
const failed = await textbee.getMessages({ smsBatchId, status: 'failed' })

// Drain everything matching a filter: iterateMessages follows the
// pagination cursor for you until there is nothing left
for await (const message of textbee.iterateMessages({ direction: 'received', order: 'asc' })) {
  console.log(message.sender, message.message)
}

// A single message and its current status
const sms = await textbee.getSms(deviceId, smsId)

// A whole batch, using the smsBatchId returned by sendSms
const { batch, messages } = await textbee.getSmsBatch(deviceId, smsBatchId)
```

## Verifying webhooks

textbee signs each webhook delivery with HMAC-SHA256 and sends the hex digest in the `X-Signature` header. Pass the raw request body, not a re-serialized object, whenever your framework gives you access to it.

```js
import { verifyWebhookSignature } from '@textbee/sdk'

app.post('/webhooks/textbee', express.raw({ type: 'application/json' }), async (req, res) => {
  const valid = await verifyWebhookSignature({
    payload: req.body.toString('utf8'),
    signature: req.get('x-signature'),
    signingSecret: process.env.TEXTBEE_WEBHOOK_SECRET,
  })

  if (!valid) return res.sendStatus(401)

  const event = JSON.parse(req.body.toString('utf8'))
  res.sendStatus(200)
})
```

## SMS utilities

Pure helpers for working with SMS text and phone numbers. No API key, no network calls, and they are useful with any SMS provider, not just textbee. Import only what you need and the rest is tree-shaken away.

### Segments and encoding

Carriers bill per segment, not per message. A message stays in the 7-bit GSM alphabet at 160 characters per segment, but a single character outside that alphabet, one emoji or one curly quote, switches the whole message to UCS-2 and drops the limit to 70.

```js
import { countSmsSegments, getSmsEncoding, findNonGsm7Characters } from '@textbee/sdk'

countSmsSegments('Your code is 123456')
// { encoding: 'gsm-7', length: 19, segments: 1, remainingInSegment: 141 }

countSmsSegments('Your code is 123456 🎉')
// { encoding: 'ucs-2', length: 22, segments: 1, remainingInSegment: 48 }

getSmsEncoding('plain ascii') // 'gsm-7'
findNonGsm7Characters('Hi 🎉') // ['🎉']
```

Longer messages are split, and concatenation headers shrink each segment to 153 characters (GSM-7) or 67 (UCS-2). `remainingInSegment` counts single-unit characters, so a two-unit character such as an emoji or `€` may not fit even when it reads as 1.

### Keeping messages in GSM-7

Text pasted from a word processor or a CMS is full of curly quotes, ellipses, and non-breaking spaces. `sanitizeForGsm7` swaps them for plain equivalents so a message does not silently cost three times as much.

```js
import { sanitizeForGsm7, countSmsSegments } from '@textbee/sdk'

const pasted = '“Your order shipped…”'
countSmsSegments(pasted).encoding // 'ucs-2'

const clean = sanitizeForGsm7(pasted) // '"Your order shipped..."'
countSmsSegments(clean).encoding // 'gsm-7'

// Optionally strip accents that GSM-7 does not carry. Letters it does carry,
// like é, ü, and ñ, are always left alone.
sanitizeForGsm7('naïve', { transliterateAccents: true }) // 'naive'
```

It is best effort: characters with no safe equivalent pass through untouched. Check the result with `getSmsEncoding` and see what is left with `findNonGsm7Characters`.

### Phone number helpers

```js
import { isValidE164, normalizePhoneNumber } from '@textbee/sdk'

isValidE164('+12025550123') // true
isValidE164('202-555-0123') // false

normalizePhoneNumber('+1 (202) 555-0123') // '+12025550123'
normalizePhoneNumber('0012025550123') // '+12025550123'
normalizePhoneNumber('(202) 555-0123', { defaultCountryCode: '1' }) // '+12025550123'
normalizePhoneNumber('not a number') // null
```

These are format-only helpers, not [libphonenumber](https://github.com/google/libphonenumber). They know nothing about country dialing plans, so a well-formed but unassigned number still passes. Input that cannot be normalized returns `null`; an unusable `defaultCountryCode` throws a `TypeError`.

## Errors

Any non-2xx response throws a `TextbeeError` carrying the status and the parsed body. Network failures reject with the underlying `fetch` error instead.

```js
import { TextbeeError } from '@textbee/sdk'

try {
  await textbee.sendSms({ recipients: ['+12025550123'], message: 'hi' })
} catch (error) {
  if (error instanceof TextbeeError) {
    console.error(error.status, error.message)
  } else {
    throw error
  }
}
```

## Client options

```js
new Textbee({
  apiKey: 'your-api-key',
  baseUrl: 'https://api.textbee.dev/api/v1', // override for self-hosted instances
})
```

## What is not covered yet

The SDK focuses on sending and reading messages. Bulk send and a few device operations are still REST only, documented at [textbee.dev/docs](https://textbee.dev/docs).

## Community and support

Questions or feedback? Join the community on [Discord](https://textbee.dev/discord) or email support@textbee.dev.

## License

MIT. Part of the [textbee](https://github.com/vernu/textbee) project.
