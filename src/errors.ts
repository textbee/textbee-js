/**
 * Thrown when the textbee API answers with a non-2xx status.
 *
 * Network failures are not wrapped: those reject with whatever `fetch` threw.
 */
export class TextbeeError extends Error {
  /** HTTP status code returned by the API. */
  readonly status: number

  /** Parsed response body, or the raw text when the body was not JSON. */
  readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'TextbeeError'
    this.status = status
    this.body = body
  }
}
