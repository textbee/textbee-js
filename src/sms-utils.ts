/**
 * Pure SMS helpers. No API key, no network, no dependencies. They work with
 * any SMS provider, not just textbee.
 */

// ---------------------------------------------------------------------------
// GSM 03.38 character tables
// ---------------------------------------------------------------------------

/**
 * The GSM 03.38 default alphabet, one septet per character.
 *
 * @ £ $ ¥ è é ù ì ò Ç LF Ø ø CR Å å Δ _ Φ Γ Λ Ω Π Ψ Σ Θ Ξ Æ æ ß É
 * space ! " # ¤ % & ' ( ) * + , - . / 0-9 : ; < = > ?
 * ¡ A-Z Ä Ö Ñ Ü § ¿ a-z ä ö ñ ü à
 *
 * Non-ASCII entries are escaped so lookalike characters cannot sneak in.
 */
const GSM7_BASE =
  '@\u00A3$\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\n\u00D8\u00F8\r\u00C5\u00E5' +
  '\u0394_\u03A6\u0393\u039B\u03A9\u03A0\u03A8\u03A3\u0398\u039E' +
  '\u00C6\u00E6\u00DF\u00C9' +
  ' !"#\u00A4%&\'()*+,-./0123456789:;<=>?' +
  '\u00A1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00C4\u00D6\u00D1\u00DC\u00A7' +
  '\u00BFabcdefghijklmnopqrstuvwxyz\u00E4\u00F6\u00F1\u00FC\u00E0'

/**
 * The GSM 03.38 extension table. Each of these costs two septets because it is
 * sent as an escape byte followed by the character.
 *
 * form feed, ^ { } \ [ ~ ] | and the euro sign
 */
const GSM7_EXTENSION = '\f^{}\\[~]|\u20AC'

const GSM7_BASE_SET = new Set(GSM7_BASE)
const GSM7_EXTENSION_SET = new Set(GSM7_EXTENSION)

const GSM7_SINGLE_SEGMENT_LIMIT = 160
const GSM7_CONCATENATED_SEGMENT_LIMIT = 153
const UCS2_SINGLE_SEGMENT_LIMIT = 70
const UCS2_CONCATENATED_SEGMENT_LIMIT = 67

/** Septets a character costs in GSM-7, or undefined when it is not encodable. */
function gsm7Cost(char: string): 1 | 2 | undefined {
  if (GSM7_BASE_SET.has(char)) {
    return 1
  }
  if (GSM7_EXTENSION_SET.has(char)) {
    return 2
  }
  return undefined
}

function isGsm7Char(char: string): boolean {
  return gsm7Cost(char) !== undefined
}

// ---------------------------------------------------------------------------
// Segments and encoding
// ---------------------------------------------------------------------------

/** How the message body will be encoded on the wire. */
export type SmsEncoding = 'gsm-7' | 'ucs-2'

export interface SmsSegmentInfo {
  /** `gsm-7` when every character fits the GSM 03.38 alphabet, else `ucs-2`. */
  encoding: SmsEncoding

  /**
   * Encoded length: septets for gsm-7 (extension characters cost 2), UTF-16
   * code units for ucs-2 (emoji and other astral characters cost 2).
   */
  length: number

  /** Number of SMS segments the message occupies. 0 for an empty string. */
  segments: number

  /**
   * How many more single-unit characters fit before another segment is needed.
   * A two-unit character (extension character or emoji) may not fit even when
   * this is 1.
   */
  remainingInSegment: number
}

/**
 * Detect the encoding a message requires: `gsm-7` when every character is in
 * the GSM 03.38 alphabet or its extension table, `ucs-2` otherwise. An empty
 * string reports `gsm-7`.
 */
export function getSmsEncoding(message: string): SmsEncoding {
  for (const char of message) {
    if (!isGsm7Char(char)) {
      return 'ucs-2'
    }
  }
  return 'gsm-7'
}

/**
 * Compute encoding, encoded length, segment count, and remaining room the way
 * a standards-following handset splits a message.
 *
 * Single segment limits are 160 septets (gsm-7) and 70 code units (ucs-2).
 * Concatenated messages carry a header, shrinking each segment to 153 and 67.
 * A two-unit character never straddles a boundary: it moves whole to the next
 * segment and wastes one unit.
 */
export function countSmsSegments(message: string): SmsSegmentInfo {
  const encoding = getSmsEncoding(message)
  const costs = characterCosts(message, encoding)
  const length = costs.reduce((total, cost) => total + cost, 0)

  if (length === 0) {
    return {
      encoding,
      length: 0,
      segments: 0,
      remainingInSegment:
        encoding === 'gsm-7'
          ? GSM7_SINGLE_SEGMENT_LIMIT
          : UCS2_SINGLE_SEGMENT_LIMIT,
    }
  }

  const singleLimit =
    encoding === 'gsm-7' ? GSM7_SINGLE_SEGMENT_LIMIT : UCS2_SINGLE_SEGMENT_LIMIT

  if (length <= singleLimit) {
    return {
      encoding,
      length,
      segments: 1,
      remainingInSegment: singleLimit - length,
    }
  }

  const concatenatedLimit =
    encoding === 'gsm-7'
      ? GSM7_CONCATENATED_SEGMENT_LIMIT
      : UCS2_CONCATENATED_SEGMENT_LIMIT

  let segments = 1
  let usedInSegment = 0

  for (const cost of costs) {
    if (usedInSegment + cost > concatenatedLimit) {
      segments += 1
      usedInSegment = cost
    } else {
      usedInSegment += cost
    }
  }

  return {
    encoding,
    length,
    segments,
    remainingInSegment: concatenatedLimit - usedInSegment,
  }
}

/**
 * The unique characters forcing a message into ucs-2, in first appearance
 * order. Empty when the message is already gsm-7 safe. Pair it with
 * {@link sanitizeForGsm7} to see what is left after sanitizing.
 */
export function findNonGsm7Characters(message: string): string[] {
  const found = new Set<string>()

  for (const char of message) {
    if (!isGsm7Char(char)) {
      found.add(char)
    }
  }

  return Array.from(found)
}

/** Per-character unit costs, in message order. */
function characterCosts(message: string, encoding: SmsEncoding): number[] {
  const costs: number[] = []

  for (const char of message) {
    costs.push(encoding === 'gsm-7' ? (gsm7Cost(char) ?? 1) : char.length)
  }

  return costs
}

// ---------------------------------------------------------------------------
// GSM-7 sanitization
// ---------------------------------------------------------------------------

/**
 * Unicode characters that have a safe GSM-7 equivalent. Keys are escaped so
 * this file stays readable and never carries the very characters it replaces.
 */
const GSM7_REPLACEMENTS: Record<string, string> = {
  // curly single quotes, prime, acute accent, backtick
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u201B': "'",
  '\u2032': "'",
  '\u00B4': "'",
  '`': "'",

  // curly double quotes, double prime, guillemets
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u201F': '"',
  '\u2033': '"',
  '\u00AB': '"',
  '\u00BB': '"',

  // ellipsis
  '\u2026': '...',

  // hyphen variants, en dash, em dash, horizontal bar, minus sign
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',

  // non-breaking and typographic spaces
  '\u00A0': ' ',
  '\u2000': ' ',
  '\u2001': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2004': ' ',
  '\u2005': ' ',
  '\u2006': ' ',
  '\u2007': ' ',
  '\u2008': ' ',
  '\u2009': ' ',
  '\u200A': ' ',
  '\u202F': ' ',
  '\u205F': ' ',
  '\u3000': ' ',

  // invisible characters worth dropping outright
  '\u200B': '',
  '\uFEFF': '',
  '\u00AD': '',

  // fraction slash
  '\u2044': '/',
}

/** Letters NFD cannot decompose into an ASCII base letter. */
const TRANSLITERATION_EXTRAS: Record<string, string> = {
  '\u0152': 'OE',
  '\u0153': 'oe',
  '\u0141': 'L',
  '\u0142': 'l',
  '\u0110': 'D',
  '\u0111': 'd',
  '\u0131': 'i',
}

const COMBINING_MARKS = /[\u0300-\u036F]/g

export interface SanitizeForGsm7Options {
  /**
   * Strip accents from Latin letters that GSM-7 does not carry, so `ï` becomes
   * `i`. Letters GSM-7 already has (é, ü, ñ, à and friends) are never touched.
   * Defaults to false.
   */
  transliterateAccents?: boolean
}

/**
 * Replace common Unicode lookalikes (curly quotes, ellipsis, exotic spaces and
 * dashes) with GSM-7 equivalents, so pasted text does not silently fall into
 * ucs-2 and more than double its segment count.
 *
 * Best effort by design: characters with no safe replacement are left alone.
 * Check the result with {@link getSmsEncoding} and inspect leftovers with
 * {@link findNonGsm7Characters}.
 */
export function sanitizeForGsm7(
  message: string,
  options: SanitizeForGsm7Options = {},
): string {
  const { transliterateAccents = false } = options
  let result = ''

  for (const char of message) {
    const replacement = GSM7_REPLACEMENTS[char]
    if (replacement !== undefined) {
      result += replacement
      continue
    }

    if (isGsm7Char(char)) {
      result += char
      continue
    }

    result += transliterateAccents ? transliterate(char) : char
  }

  return result
}

/** Best-effort ASCII form of a single character, or the character unchanged. */
function transliterate(char: string): string {
  const extra = TRANSLITERATION_EXTRAS[char]
  if (extra !== undefined) {
    return extra
  }

  const stripped = char.normalize('NFD').replace(COMBINING_MARKS, '')
  if (stripped.length === 1 && /[A-Za-z]/.test(stripped)) {
    return stripped
  }

  return char
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

const E164_PATTERN = /^\+[1-9]\d{1,14}$/
const FORMATTING_CHARACTERS = /[\s.\-()]/g
const DIGITS_ONLY = /^\d+$/
const COUNTRY_CODE_PATTERN = /^[1-9]\d{0,2}$/

/**
 * Check that a string is strictly E.164: a plus sign, a leading digit 1-9, then
 * 1 to 14 more digits, nothing else.
 *
 * This is a format check only. It does not know country dialing plans, so a
 * well-formed but unassigned number still passes.
 */
export function isValidE164(input: string): boolean {
  return E164_PATTERN.test(input)
}

export interface NormalizePhoneNumberOptions {
  /**
   * Country calling code applied to national-format input, with or without a
   * leading plus: `1` and `+1` both work. With it, `(202) 555-0123` becomes
   * `+12025550123` and one leading trunk zero is dropped. Without it,
   * national-format input returns null.
   */
  defaultCountryCode?: string
}

/**
 * Normalize free-form phone input to E.164, or return null when it cannot be
 * done safely. Strips spaces, dots, hyphens and parentheses, converts a leading
 * `00` to a plus, and optionally applies a default country code.
 *
 * This is a formatter, not libphonenumber: it never validates a number against
 * a country dialing plan. Bad input returns null, a bad
 * {@link NormalizePhoneNumberOptions.defaultCountryCode} throws.
 */
export function normalizePhoneNumber(
  input: string,
  options: NormalizePhoneNumberOptions = {},
): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const hasPlus = trimmed.startsWith('+')
  const withoutPlus = hasPlus ? trimmed.slice(1) : trimmed
  const digits = withoutPlus.replace(FORMATTING_CHARACTERS, '')

  if (!DIGITS_ONLY.test(digits)) {
    return null
  }

  if (hasPlus) {
    return asE164OrNull(`+${digits}`)
  }

  if (digits.startsWith('00')) {
    return asE164OrNull(`+${digits.slice(2)}`)
  }

  const countryCode = normalizeCountryCode(options.defaultCountryCode)
  if (countryCode === undefined) {
    return null
  }

  const national = digits.startsWith('0') ? digits.slice(1) : digits

  return asE164OrNull(`+${countryCode}${national}`)
}

function asE164OrNull(candidate: string): string | null {
  return isValidE164(candidate) ? candidate : null
}

function normalizeCountryCode(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const code = value.startsWith('+') ? value.slice(1) : value
  if (!COUNTRY_CODE_PATTERN.test(code)) {
    throw new TypeError(
      `defaultCountryCode must be 1 to 3 digits starting with 1-9, got ${JSON.stringify(value)}`,
    )
  }

  return code
}
