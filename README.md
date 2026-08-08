# @textbee/sdk

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
  recipients: ['+251912345678'],
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
  recipients: ['+251912345678'],
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

```js
// Paginated history, filterable and searchable
const { data, meta } = await textbee.getMessages(deviceId, {
  type: 'received', // 'all' | 'sent' | 'received'
  page: 1,
  limit: 50,
  search: 'invoice',
})

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

## Errors

Any non-2xx response throws a `TextbeeError` carrying the status and the parsed body. Network failures reject with the underlying `fetch` error instead.

```js
import { TextbeeError } from '@textbee/sdk'

try {
  await textbee.sendSms({ recipients: ['+251912345678'], message: 'hi' })
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

v0.0.1 focuses on sending and reading messages. Bulk send and a few device operations are still REST only, documented at [textbee.dev/docs](https://textbee.dev/docs).

## License

MIT. Part of the [textbee](https://github.com/vernu/textbee) project.
