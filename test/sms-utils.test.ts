import { describe, expect, it } from 'vitest'

import {
  countSmsSegments,
  findNonGsm7Characters,
  getSmsEncoding,
  isValidE164,
  normalizePhoneNumber,
  sanitizeForGsm7,
} from '../src/index'

const EURO = '\u20AC'
const THUMBS_UP = '\u{1F44D}'
const EM_DASH = '\u2014'
const EN_DASH = '\u2013'
const ELLIPSIS = '\u2026'
const LEFT_DOUBLE_QUOTE = '\u201C'
const RIGHT_DOUBLE_QUOTE = '\u201D'
const LEFT_SINGLE_QUOTE = '\u2018'
const RIGHT_SINGLE_QUOTE = '\u2019'
const NON_BREAKING_SPACE = '\u00A0'
const THIN_SPACE = '\u2009'
const ZERO_WIDTH_SPACE = '\u200B'
const BYTE_ORDER_MARK = '\uFEFF'
const SOFT_HYPHEN = '\u00AD'
const ZERO_WIDTH_JOINER = '\u200D'
const TURKISH_S_CEDILLA = '\u015F'
const I_DIAERESIS = '\u00EF'
const E_ACUTE = '\u00E9'
const LONE_SURROGATE = '\uD83D'

describe('getSmsEncoding', () => {
  it('treats an empty string as gsm-7', () => {
    expect(getSmsEncoding('')).toBe('gsm-7')
  })

  it('accepts plain ascii and the accented letters gsm-7 carries', () => {
    expect(getSmsEncoding('hello')).toBe('gsm-7')
    expect(getSmsEncoding('é ü ñ à Ω')).toBe('gsm-7')
  })

  it('accepts every extension table character', () => {
    for (const char of ['|', '^', EURO, '{', '}', '[', ']', '~', '\\']) {
      expect(getSmsEncoding(char)).toBe('gsm-7')
    }
  })

  it('falls back to ucs-2 for characters outside the alphabet', () => {
    expect(getSmsEncoding(TURKISH_S_CEDILLA)).toBe('ucs-2')
    expect(getSmsEncoding(EM_DASH)).toBe('ucs-2')
    expect(getSmsEncoding(THUMBS_UP)).toBe('ucs-2')
    expect(getSmsEncoding('`')).toBe('ucs-2')
    expect(getSmsEncoding(LONE_SURROGATE)).toBe('ucs-2')
  })
})

describe('countSmsSegments, gsm-7', () => {
  it('reports zero segments for an empty message', () => {
    expect(countSmsSegments('')).toEqual({
      encoding: 'gsm-7',
      length: 0,
      segments: 0,
      remainingInSegment: 160,
    })
  })

  it('counts a short message', () => {
    expect(countSmsSegments('hello')).toEqual({
      encoding: 'gsm-7',
      length: 5,
      segments: 1,
      remainingInSegment: 155,
    })
  })

  it('fits exactly 160 characters in one segment', () => {
    expect(countSmsSegments('a'.repeat(160))).toEqual({
      encoding: 'gsm-7',
      length: 160,
      segments: 1,
      remainingInSegment: 0,
    })
  })

  it('splits at 161 characters and drops to the 153 limit', () => {
    expect(countSmsSegments('a'.repeat(161))).toEqual({
      encoding: 'gsm-7',
      length: 161,
      segments: 2,
      remainingInSegment: 145,
    })
  })

  it('fills two segments exactly at 306 and needs a third at 307', () => {
    expect(countSmsSegments('a'.repeat(306)).segments).toBe(2)
    expect(countSmsSegments('a'.repeat(306)).remainingInSegment).toBe(0)
    expect(countSmsSegments('a'.repeat(307)).segments).toBe(3)
  })

  it('charges two septets for extension characters', () => {
    expect(countSmsSegments(EURO).length).toBe(2)
    expect(countSmsSegments('{}').length).toBe(4)
  })

  it('keeps an extension character inside a single segment at the limit', () => {
    expect(countSmsSegments('a'.repeat(158) + EURO)).toEqual({
      encoding: 'gsm-7',
      length: 160,
      segments: 1,
      remainingInSegment: 0,
    })
    expect(countSmsSegments('a'.repeat(159) + EURO).segments).toBe(2)
  })

  it('never straddles an extension character across a boundary', () => {
    const message = 'a'.repeat(152) + EURO + 'a'.repeat(152)

    // 306 septets would fit two 153 septet segments, but the euro sign cannot
    // be split, so one septet is wasted and a third segment is needed.
    expect(countSmsSegments(message)).toEqual({
      encoding: 'gsm-7',
      length: 306,
      segments: 3,
      remainingInSegment: 152,
    })
  })

  it('counts newline and carriage return as one septet each', () => {
    expect(countSmsSegments('a\nb\rc')).toEqual({
      encoding: 'gsm-7',
      length: 5,
      segments: 1,
      remainingInSegment: 155,
    })
  })
})

describe('countSmsSegments, ucs-2', () => {
  it('counts an astral character as two code units', () => {
    expect(countSmsSegments(THUMBS_UP)).toEqual({
      encoding: 'ucs-2',
      length: 2,
      segments: 1,
      remainingInSegment: 68,
    })
  })

  it('flips the whole message to ucs-2 when one character requires it', () => {
    expect(countSmsSegments(`hello ${THUMBS_UP}`)).toEqual({
      encoding: 'ucs-2',
      length: 8,
      segments: 1,
      remainingInSegment: 62,
    })
  })

  it('fits exactly 70 code units in one segment and splits at 71', () => {
    expect(countSmsSegments(TURKISH_S_CEDILLA.repeat(70))).toEqual({
      encoding: 'ucs-2',
      length: 70,
      segments: 1,
      remainingInSegment: 0,
    })
    expect(countSmsSegments(TURKISH_S_CEDILLA.repeat(71))).toEqual({
      encoding: 'ucs-2',
      length: 71,
      segments: 2,
      remainingInSegment: 63,
    })
  })

  it('never straddles a surrogate pair across a boundary', () => {
    const message = 'a'.repeat(66) + THUMBS_UP + 'a'.repeat(100)

    expect(countSmsSegments(message)).toEqual({
      encoding: 'ucs-2',
      length: 168,
      segments: 3,
      remainingInSegment: 32,
    })
  })

  it('handles a lone surrogate without crashing', () => {
    expect(countSmsSegments(LONE_SURROGATE)).toEqual({
      encoding: 'ucs-2',
      length: 1,
      segments: 1,
      remainingInSegment: 69,
    })
  })
})

describe('findNonGsm7Characters', () => {
  it('returns nothing for a gsm-7 safe message', () => {
    expect(findNonGsm7Characters('hello, world!')).toEqual([])
  })

  it('lists unique offenders in first appearance order', () => {
    const message = `${LEFT_DOUBLE_QUOTE}hi${RIGHT_DOUBLE_QUOTE} ${EM_DASH} ${THUMBS_UP} ${LEFT_DOUBLE_QUOTE}again${RIGHT_DOUBLE_QUOTE}`

    expect(findNonGsm7Characters(message)).toEqual([
      LEFT_DOUBLE_QUOTE,
      RIGHT_DOUBLE_QUOTE,
      EM_DASH,
      THUMBS_UP,
    ])
  })

  it('reports a lone surrogate', () => {
    expect(findNonGsm7Characters(LONE_SURROGATE)).toEqual([LONE_SURROGATE])
  })
})

describe('sanitizeForGsm7', () => {
  it('returns gsm-7 safe input unchanged', () => {
    expect(sanitizeForGsm7('')).toBe('')
    expect(sanitizeForGsm7('Your code is 1234.')).toBe('Your code is 1234.')
    expect(sanitizeForGsm7('café über señor')).toBe('café über señor')
  })

  it('straightens curly quotes', () => {
    const message = `${LEFT_SINGLE_QUOTE}a${RIGHT_SINGLE_QUOTE} ${LEFT_DOUBLE_QUOTE}b${RIGHT_DOUBLE_QUOTE}`

    expect(sanitizeForGsm7(message)).toBe(`'a' "b"`)
  })

  it('replaces dashes and the ellipsis', () => {
    expect(sanitizeForGsm7(`a${EN_DASH}b${EM_DASH}c`)).toBe('a-b-c')
    expect(sanitizeForGsm7(`wait${ELLIPSIS}`)).toBe('wait...')
  })

  it('normalizes exotic spaces and drops invisible characters', () => {
    expect(sanitizeForGsm7(`a${NON_BREAKING_SPACE}b${THIN_SPACE}c`)).toBe(
      'a b c',
    )
    expect(
      sanitizeForGsm7(`a${ZERO_WIDTH_SPACE}${BYTE_ORDER_MARK}${SOFT_HYPHEN}b`),
    ).toBe('ab')
  })

  it('rescues a message from ucs-2', () => {
    const message = `${LEFT_DOUBLE_QUOTE}Hi${RIGHT_DOUBLE_QUOTE}${ELLIPSIS}`

    expect(countSmsSegments(message).encoding).toBe('ucs-2')
    expect(countSmsSegments(sanitizeForGsm7(message)).encoding).toBe('gsm-7')
  })

  it('preserves zero width joiners so emoji sequences survive', () => {
    const family = `👨${ZERO_WIDTH_JOINER}👩${ZERO_WIDTH_JOINER}👧`

    expect(sanitizeForGsm7(family)).toBe(family)
  })

  it('leaves unmapped characters alone by default', () => {
    expect(sanitizeForGsm7(`na${I_DIAERESIS}ve`)).toBe(`na${I_DIAERESIS}ve`)
    expect(sanitizeForGsm7(TURKISH_S_CEDILLA)).toBe(TURKISH_S_CEDILLA)
  })

  it('strips accents when asked', () => {
    const options = { transliterateAccents: true }

    expect(sanitizeForGsm7(`na${I_DIAERESIS}ve`, options)).toBe('naive')
    expect(sanitizeForGsm7(TURKISH_S_CEDILLA, options)).toBe('s')
    expect(sanitizeForGsm7('Łódź', options)).toBe('Lodz')
    expect(sanitizeForGsm7('Œuvre', options)).toBe('OEuvre')
  })

  it('keeps letters gsm-7 already carries even when transliterating', () => {
    const options = { transliterateAccents: true }

    expect(sanitizeForGsm7(`caf${E_ACUTE}`, options)).toBe(`caf${E_ACUTE}`)
    expect(sanitizeForGsm7('über señor à', options)).toBe('über señor à')
  })

  it('does not touch non-latin scripts or emoji when transliterating', () => {
    const options = { transliterateAccents: true }

    expect(sanitizeForGsm7('こんにちは', options)).toBe('こんにちは')
    expect(sanitizeForGsm7('مرحبا', options)).toBe('مرحبا')
    expect(sanitizeForGsm7(THUMBS_UP, options)).toBe(THUMBS_UP)
  })

  it('is idempotent', () => {
    const message = `${LEFT_DOUBLE_QUOTE}a${RIGHT_DOUBLE_QUOTE}${EM_DASH}b${ELLIPSIS}${NON_BREAKING_SPACE}c`
    const once = sanitizeForGsm7(message)

    expect(sanitizeForGsm7(once)).toBe(once)
  })
})

describe('isValidE164', () => {
  it('accepts well formed numbers', () => {
    expect(isValidE164('+12025550123')).toBe(true)
    expect(isValidE164('+12')).toBe(true)
    expect(isValidE164('+123456789012345')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isValidE164('')).toBe(false)
    expect(isValidE164('+')).toBe(false)
    expect(isValidE164('+1')).toBe(false)
    expect(isValidE164('+02025550123')).toBe(false)
    expect(isValidE164('12025550123')).toBe(false)
    expect(isValidE164('+1202 555 0123')).toBe(false)
    expect(isValidE164('+1234567890123456')).toBe(false)
    expect(isValidE164('0012025550123')).toBe(false)
    expect(isValidE164(' +12 ')).toBe(false)
  })
})

describe('normalizePhoneNumber', () => {
  it('strips formatting from an international number', () => {
    expect(normalizePhoneNumber('+1 202-555-0123')).toBe('+12025550123')
    expect(normalizePhoneNumber('+1 (202) 555.0123')).toBe('+12025550123')
    expect(normalizePhoneNumber('  +12025550123  ')).toBe('+12025550123')
  })

  it('converts a leading 00 to a plus', () => {
    expect(normalizePhoneNumber('0012025550123')).toBe('+12025550123')
    expect(normalizePhoneNumber('00 1 202 555 0123')).toBe('+12025550123')
  })

  it('applies a default country code to national input', () => {
    expect(
      normalizePhoneNumber('(202) 555-0123', { defaultCountryCode: '1' }),
    ).toBe('+12025550123')
    expect(
      normalizePhoneNumber('2025550123', { defaultCountryCode: '+1' }),
    ).toBe('+12025550123')
  })

  it('drops a single trunk zero', () => {
    expect(
      normalizePhoneNumber('020 7946 0123', { defaultCountryCode: '44' }),
    ).toBe('+442079460123')
  })

  it('returns null for national input without a country code', () => {
    expect(normalizePhoneNumber('2025550123')).toBeNull()
    expect(normalizePhoneNumber('020 7946 0123')).toBeNull()
  })

  it('returns null for input it cannot normalize', () => {
    expect(normalizePhoneNumber('')).toBeNull()
    expect(normalizePhoneNumber('   ')).toBeNull()
    expect(normalizePhoneNumber('not a number')).toBeNull()
    expect(normalizePhoneNumber('+1 202 555 0123 ext 22')).toBeNull()
    expect(normalizePhoneNumber('+1+2025550123')).toBeNull()
    expect(normalizePhoneNumber('+02025550123')).toBeNull()
    expect(normalizePhoneNumber('+1202555012345678')).toBeNull()
  })

  it('throws on an unusable default country code', () => {
    expect(() =>
      normalizePhoneNumber('2025550123', { defaultCountryCode: '0' }),
    ).toThrow(TypeError)
    expect(() =>
      normalizePhoneNumber('2025550123', { defaultCountryCode: 'abc' }),
    ).toThrow(TypeError)
  })
})
