import { StringDecoder } from 'node:string_decoder'

import type { ScrubOptions } from './types.js'

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g
const APPROVAL_ID_PATTERN = /\bbelay_[a-z0-9]{8,}\b/gi
const TOKEN_PREFIX_PATTERN = /\/belay-approve\s+\S+/gi
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi
const AUTH_HEADER_PATTERN = /(?<!["'])\bAuthorization:\s*(?:Bearer|Basic|Token)?\s*\S+/gi
const DOUBLE_QUOTED_AUTH_HEADER_PATTERN = /"Authorization:\s*[^"]*"/gi
const SINGLE_QUOTED_AUTH_HEADER_PATTERN = /'Authorization:\s*[^']*'/gi
const GENERIC_AUTH_HEADER_PATTERN = /(?<!["'])\b(?:X-Api-Key|X-Auth-Token|Private-Token):\s*\S+/gi
const DOUBLE_QUOTED_GENERIC_AUTH_HEADER_PATTERN =
  /"(X-Api-Key|X-Auth-Token|Private-Token):\s*[^"]*"/gi
const SINGLE_QUOTED_GENERIC_AUTH_HEADER_PATTERN =
  /'(X-Api-Key|X-Auth-Token|Private-Token):\s*[^']*'/gi
const KEY_VALUE_SECRET_PATTERN =
  /\b(api[_-]?key|token|secret|password|passwd|credential)\b\s*[:=]\s*['"]?[^\s'"]{4,}/gi
const URL_CREDENTIALS_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/g
const MYSQL_INLINE_PASSWORD_PATTERN = /(\s-p)([^\s]+)/g
const HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g

const DEFAULT_SCRUB_OPTIONS: Required<ScrubOptions> = {
  maskApprovalIds: true,
  maskBearerTokens: true,
  maskAuthHeaders: true,
  maskKeyValueSecrets: true,
  maskHighEntropyStrings: true,
}

function resolvedScrubOptions(options: ScrubOptions = {}): Required<ScrubOptions> {
  return {
    maskApprovalIds: options.maskApprovalIds !== false,
    maskBearerTokens: options.maskBearerTokens !== false,
    maskAuthHeaders: options.maskAuthHeaders !== false,
    maskKeyValueSecrets: options.maskKeyValueSecrets !== false,
    maskHighEntropyStrings: options.maskHighEntropyStrings === true,
  }
}

export function scrubString(value: string, options: ScrubOptions = {}): string {
  const resolved = resolvedScrubOptions(options)
  let scrubbed = value.replace(UUID_PATTERN, '<uuid>').replace(TIMESTAMP_PATTERN, '<timestamp>')

  if (resolved.maskApprovalIds) {
    scrubbed = scrubbed
      .replace(APPROVAL_ID_PATTERN, '<approval-id>')
      .replace(TOKEN_PREFIX_PATTERN, '/belay-approve <approval-id>')
  }
  if (resolved.maskBearerTokens) {
    scrubbed = scrubbed.replace(BEARER_PATTERN, 'Bearer <redacted>')
  }
  if (resolved.maskAuthHeaders) {
    scrubbed = scrubbed
      .replace(DOUBLE_QUOTED_AUTH_HEADER_PATTERN, '"Authorization: <redacted>"')
      .replace(SINGLE_QUOTED_AUTH_HEADER_PATTERN, "'Authorization: <redacted>'")
      .replace(
        DOUBLE_QUOTED_GENERIC_AUTH_HEADER_PATTERN,
        (_match, header: string) => `"${header}: <redacted>"`,
      )
      .replace(
        SINGLE_QUOTED_GENERIC_AUTH_HEADER_PATTERN,
        (_match, header: string) => `'${header}: <redacted>'`,
      )
      .replace(AUTH_HEADER_PATTERN, 'Authorization: <redacted>')
      .replace(GENERIC_AUTH_HEADER_PATTERN, (match) => {
        const separatorIndex = match.indexOf(':')
        return `${match.slice(0, separatorIndex + 1)} <redacted>`
      })
  }
  if (resolved.maskKeyValueSecrets) {
    scrubbed = scrubbed
      .replace(URL_CREDENTIALS_PATTERN, '$1<redacted>:<redacted>@')
      .replace(MYSQL_INLINE_PASSWORD_PATTERN, '$1<redacted>')
    scrubbed = scrubbed.replace(KEY_VALUE_SECRET_PATTERN, (match) => {
      const separatorMatch = match.match(/\s*[:=]\s*/)
      if (!separatorMatch || separatorMatch.index === undefined) {
        return '<secret>'
      }
      return `${match.slice(0, separatorMatch.index)}${separatorMatch[0]}<redacted>`
    })
  }
  if (resolved.maskHighEntropyStrings) {
    scrubbed = scrubbed.replace(HIGH_ENTROPY_PATTERN, '<high-entropy>')
  }

  return scrubbed
}

export interface StreamingScrubber {
  /** Raw, undecided UTF-8 bytes retained between writes. */
  readonly bufferedBytes: number
  write(chunk: Buffer | string): string
  end(): string
}

export const STREAMING_SCRUBBER_MAX_BUFFER_BYTES = 256

type MarkerKind =
  | 'approval_command'
  | 'approval_id'
  | 'authorization'
  | 'bearer'
  | 'generic_header'
  | 'key_name'
  | 'mysql_password'
  | 'quoted_authorization'
  | 'quoted_generic_header'
  | 'url_authority'

interface Marker {
  kind: MarkerKind
  length: number
  quote?: '"' | "'"
}

type StreamState =
  | { kind: 'approval_wait' }
  | { kind: 'approval_id_value' }
  | {
      kind: 'authorization_value'
      phase: 'leading' | 'first_word' | 'after_scheme' | 'credential'
      firstWord: string
    }
  | { kind: 'bearer_wait' }
  | { kind: 'bearer_value'; phase: 'leading' | 'value' }
  | { kind: 'high_entropy_value' }
  | { kind: 'key_separator' }
  | { kind: 'key_value'; phase: 'leading' | 'unquoted' }
  | { kind: 'non_whitespace_value'; phase: 'leading' | 'value' }
  | { kind: 'quoted_value'; quote: '"' | "'" }
  | { kind: 'timestamp_fraction' }
  | { kind: 'timestamp_suffix' }
  | { kind: 'url_authority' }

interface LiteralMarker {
  kind: MarkerKind
  literal: string
  requiresWordBoundary?: boolean
  quote?: '"' | "'"
}

const AUTHORIZATION_SCHEMES = ['bearer', 'basic', 'token'] as const
type ShapeCharacter = 'hex' | 'digit' | 'version' | 'variant' | '-' | 'T' | ':'

const UUID_SHAPE: readonly ShapeCharacter[] = [
  ...Array(8).fill('hex'),
  '-',
  ...Array(4).fill('hex'),
  '-',
  'version',
  ...Array(3).fill('hex'),
  '-',
  'variant',
  ...Array(3).fill('hex'),
  '-',
  ...Array(12).fill('hex'),
]
const TIMESTAMP_SHAPE: readonly ShapeCharacter[] = [
  'digit',
  'digit',
  'digit',
  'digit',
  '-',
  'digit',
  'digit',
  '-',
  'digit',
  'digit',
  'T',
  'digit',
  'digit',
  ':',
  'digit',
  'digit',
  ':',
  'digit',
  'digit',
]

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character)
}

function matchesShapeCharacter(character: string, expected: ShapeCharacter): boolean {
  if (expected === 'hex') return /[0-9a-f]/i.test(character)
  if (expected === 'digit') return /\d/.test(character)
  if (expected === 'version') return /[1-5]/.test(character)
  if (expected === 'variant') return /[89ab]/i.test(character)
  return character === expected
}

function shapePrefixMatches(value: string, shape: readonly ShapeCharacter[]): boolean {
  const length = Math.min(value.length, shape.length)
  for (let index = 0; index < length; index += 1) {
    const character = value[index]
    const expected = shape[index]
    if (!character || !expected || !matchesShapeCharacter(character, expected)) return false
  }
  return true
}

function configuredMarkers(options: Required<ScrubOptions>): LiteralMarker[] {
  const markers: LiteralMarker[] = []
  if (options.maskAuthHeaders) {
    for (const quote of ['"', "'"] as const) {
      markers.push({
        kind: 'quoted_authorization',
        literal: `${quote}Authorization:`,
        quote,
      })
      for (const header of ['X-Api-Key', 'X-Auth-Token', 'Private-Token']) {
        markers.push({
          kind: 'quoted_generic_header',
          literal: `${quote}${header}:`,
          quote,
        })
      }
    }
    markers.push({
      kind: 'authorization',
      literal: 'Authorization:',
      requiresWordBoundary: true,
    })
    for (const header of ['X-Api-Key', 'X-Auth-Token', 'Private-Token']) {
      markers.push({ kind: 'generic_header', literal: `${header}:`, requiresWordBoundary: true })
    }
  }
  if (options.maskBearerTokens) {
    markers.push({ kind: 'bearer', literal: 'Bearer', requiresWordBoundary: true })
  }
  if (options.maskKeyValueSecrets) {
    for (const name of [
      'api_key',
      'api-key',
      'apikey',
      'token',
      'secret',
      'password',
      'passwd',
      'credential',
    ]) {
      markers.push({ kind: 'key_name', literal: name, requiresWordBoundary: true })
    }
    markers.push({ kind: 'url_authority', literal: '://' })
  }
  if (options.maskApprovalIds) {
    markers.push(
      { kind: 'approval_command', literal: '/belay-approve' },
      { kind: 'approval_id', literal: 'belay_', requiresWordBoundary: true },
    )
  }
  return markers
}

/**
 * Creates a deterministic scrubber for unbounded process output.
 *
 * Only bounded, undecided grammar prefixes are retained. Once a bounded sensitive marker is
 * recognized, the scrubber enters a suppression state before consuming any unbounded whitespace,
 * credential value, or URL authority. URL authorities are conservatively hidden in full because a
 * streaming parser cannot know whether an arbitrarily long username will later be followed by a
 * password separator without retaining it.
 */
export function createStreamingScrubber(options: ScrubOptions = {}): StreamingScrubber {
  const resolved = resolvedScrubOptions(options)
  const markers = configuredMarkers(resolved)
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let previousRawCharacter: string | undefined
  let state: StreamState | undefined

  const consumeRaw = (length: number): string => {
    const consumed = pending.slice(0, length)
    pending = pending.slice(length)
    if (consumed) previousRawCharacter = consumed.at(-1)
    return consumed
  }

  const markerAtStart = (): Marker | 'awaiting' | undefined => {
    const lowerPending = pending.toLowerCase()
    let awaiting = false
    for (const candidate of markers) {
      if (candidate.requiresWordBoundary && isWordCharacter(previousRawCharacter)) continue
      const lowerLiteral = candidate.literal.toLowerCase()
      if (lowerLiteral.startsWith(lowerPending) && pending.length < candidate.literal.length) {
        awaiting = true
        continue
      }
      if (lowerPending.startsWith(lowerLiteral)) {
        return {
          kind: candidate.kind,
          length: candidate.literal.length,
          quote: candidate.quote,
        }
      }
    }

    if (resolved.maskKeyValueSecrets && /^\s$/.test(pending[0] ?? '')) {
      if (pending.length === 1) return 'awaiting'
      if (pending[1] === '-' && pending.length === 2) return 'awaiting'
      if (pending[1] === '-' && pending[2]?.toLowerCase() === 'p') {
        return { kind: 'mysql_password', length: 3 }
      }
    }
    return awaiting ? 'awaiting' : undefined
  }

  const uuidAtStart = (final: boolean): 'complete' | 'awaiting' | undefined => {
    if (isWordCharacter(previousRawCharacter) || !/[0-9a-f]/i.test(pending[0] ?? '')) return
    if (!shapePrefixMatches(pending, UUID_SHAPE)) return
    if (pending.length < UUID_SHAPE.length) return 'awaiting'
    if (pending.length === UUID_SHAPE.length && !final) return 'awaiting'
    return !isWordCharacter(pending[UUID_SHAPE.length]) ? 'complete' : undefined
  }

  const timestampAtStart = (): 'complete' | 'awaiting' | undefined => {
    if (isWordCharacter(previousRawCharacter) || !/\d/.test(pending[0] ?? '')) return
    if (!shapePrefixMatches(pending, TIMESTAMP_SHAPE)) return
    return pending.length < TIMESTAMP_SHAPE.length ? 'awaiting' : 'complete'
  }

  const highEntropyAtStart = (): 'complete' | 'awaiting' | undefined => {
    if (!resolved.maskHighEntropyStrings || isWordCharacter(previousRawCharacter)) return
    if (!/[A-Za-z0-9]/.test(pending[0] ?? '')) return
    let runLength = 0
    while (runLength < pending.length && /[A-Za-z0-9+/]/.test(pending[runLength] ?? '')) {
      runLength += 1
    }
    if (runLength >= 40) return 'complete'
    return runLength === pending.length ? 'awaiting' : undefined
  }

  const drain = (final: boolean): string => {
    let output = ''
    while (pending) {
      if (state?.kind === 'quoted_value') {
        const end = pending.indexOf(state.quote)
        if (end < 0) {
          consumeRaw(pending.length)
          break
        }
        consumeRaw(end)
        output += consumeRaw(1)
        state = undefined
        continue
      }

      if (state?.kind === 'key_separator') {
        const character = pending[0] ?? ''
        if (/\s/.test(character)) {
          output += consumeRaw(1)
          continue
        }
        if (character === ':' || character === '=') {
          output += `${consumeRaw(1)}<redacted>`
          state = { kind: 'key_value', phase: 'leading' }
          continue
        }
        state = undefined
        continue
      }

      if (state?.kind === 'bearer_wait' || state?.kind === 'approval_wait') {
        const character = pending[0] ?? ''
        if (/\s/.test(character)) {
          consumeRaw(1)
          output += state.kind === 'bearer_wait' ? ' <redacted>' : ' <approval-id>'
          state =
            state.kind === 'bearer_wait'
              ? { kind: 'bearer_value', phase: 'leading' }
              : { kind: 'non_whitespace_value', phase: 'leading' }
          continue
        }
        state = undefined
        continue
      }

      if (state?.kind === 'key_value') {
        const character = pending[0] ?? ''
        if (state.phase === 'leading') {
          if (/\s/.test(character)) {
            consumeRaw(1)
            continue
          }
          if (character === '"' || character === "'") {
            output += consumeRaw(1)
            state = { kind: 'quoted_value', quote: character }
            continue
          }
          state = { kind: 'key_value', phase: 'unquoted' }
          continue
        }
        if (/[\s'"]/.test(character)) {
          output += consumeRaw(1)
          state = undefined
          continue
        }
        consumeRaw(1)
        continue
      }

      if (state?.kind === 'non_whitespace_value') {
        const character = pending[0] ?? ''
        if (state.phase === 'leading') {
          if (/\s/.test(character)) {
            consumeRaw(1)
            continue
          }
          state = { kind: 'non_whitespace_value', phase: 'value' }
          continue
        }
        if (/\s/.test(character)) {
          output += consumeRaw(1)
          state = undefined
          continue
        }
        consumeRaw(1)
        continue
      }

      if (state?.kind === 'bearer_value') {
        const character = pending[0] ?? ''
        if (state.phase === 'leading') {
          if (/\s/.test(character)) {
            consumeRaw(1)
            continue
          }
          if (!/[A-Za-z0-9._~+/=-]/.test(character)) {
            state = undefined
            continue
          }
          state = { kind: 'bearer_value', phase: 'value' }
          continue
        }
        if (!/[A-Za-z0-9._~+/=-]/.test(character)) {
          state = undefined
          continue
        }
        consumeRaw(1)
        continue
      }

      if (state?.kind === 'authorization_value') {
        const character = pending[0] ?? ''
        if (state.phase === 'leading' || state.phase === 'after_scheme') {
          if (/\s/.test(character)) {
            consumeRaw(1)
            continue
          }
          state =
            state.phase === 'leading'
              ? { kind: 'authorization_value', phase: 'first_word', firstWord: '' }
              : { kind: 'authorization_value', phase: 'credential', firstWord: '' }
          continue
        }
        if (state.phase === 'first_word') {
          if (/\s/.test(character)) {
            const isScheme = AUTHORIZATION_SCHEMES.includes(
              state.firstWord.toLowerCase() as (typeof AUTHORIZATION_SCHEMES)[number],
            )
            consumeRaw(1)
            if (isScheme) {
              state = { kind: 'authorization_value', phase: 'after_scheme', firstWord: '' }
            } else {
              output += character
              state = undefined
            }
            continue
          }
          const firstWord = `${state.firstWord}${character}`.slice(0, 7)
          consumeRaw(1)
          const couldBeScheme = AUTHORIZATION_SCHEMES.some((scheme) =>
            scheme.startsWith(firstWord.toLowerCase()),
          )
          state = couldBeScheme
            ? { kind: 'authorization_value', phase: 'first_word', firstWord }
            : { kind: 'authorization_value', phase: 'credential', firstWord: '' }
          continue
        }
        if (/\s/.test(character)) {
          output += consumeRaw(1)
          state = undefined
          continue
        }
        consumeRaw(1)
        continue
      }

      if (state?.kind === 'approval_id_value') {
        const character = pending[0] ?? ''
        if (/[A-Za-z0-9]/.test(character)) {
          consumeRaw(1)
          continue
        }
        state = undefined
        continue
      }

      if (state?.kind === 'url_authority') {
        const character = pending[0] ?? ''
        if (/[\s/?#]/.test(character)) {
          output += consumeRaw(1)
          state = undefined
          continue
        }
        consumeRaw(1)
        continue
      }

      if (state?.kind === 'timestamp_suffix') {
        const character = pending[0] ?? ''
        if (character === 'Z') {
          consumeRaw(1)
          state = undefined
          continue
        }
        if (character === '.') {
          consumeRaw(1)
          state = { kind: 'timestamp_fraction' }
          continue
        }
        state = undefined
        continue
      }

      if (state?.kind === 'timestamp_fraction') {
        const character = pending[0] ?? ''
        if (/\d/.test(character)) {
          consumeRaw(1)
          continue
        }
        if (character === 'Z') consumeRaw(1)
        state = undefined
        continue
      }

      if (state?.kind === 'high_entropy_value') {
        const character = pending[0] ?? ''
        if (/[A-Za-z0-9+/=]/.test(character)) {
          consumeRaw(1)
          continue
        }
        state = undefined
        continue
      }

      // Resolve the bounded high-entropy candidate before literal key names. Otherwise a token
      // beginning with e.g. "token" could be mistaken for a failed key/value prefix and emitted.
      const entropy = highEntropyAtStart()
      if (entropy === 'awaiting' && !final) break
      if (entropy === 'complete') {
        consumeRaw(40)
        output += '<high-entropy>'
        state = { kind: 'high_entropy_value' }
        continue
      }

      const marker = markerAtStart()
      if (marker === 'awaiting' && !final) break
      if (marker && marker !== 'awaiting') {
        const rawMarker = consumeRaw(marker.length)
        switch (marker.kind) {
          case 'quoted_authorization':
          case 'quoted_generic_header':
            output += `${rawMarker} <redacted>`
            state = { kind: 'quoted_value', quote: marker.quote ?? '"' }
            break
          case 'authorization':
            output += `${rawMarker} <redacted>`
            state = { kind: 'authorization_value', phase: 'leading', firstWord: '' }
            break
          case 'generic_header':
            output += `${rawMarker} <redacted>`
            state = { kind: 'non_whitespace_value', phase: 'leading' }
            break
          case 'key_name':
            output += rawMarker
            state = { kind: 'key_separator' }
            break
          case 'bearer':
            output += rawMarker
            state = { kind: 'bearer_wait' }
            break
          case 'approval_command':
            output += rawMarker
            state = { kind: 'approval_wait' }
            break
          case 'approval_id':
            output += '<approval-id>'
            state = { kind: 'approval_id_value' }
            break
          case 'mysql_password':
            output += `${rawMarker}<redacted>`
            state = { kind: 'non_whitespace_value', phase: 'value' }
            break
          case 'url_authority':
            output += `${rawMarker}<redacted>`
            state = { kind: 'url_authority' }
            break
        }
        continue
      }

      const uuid = uuidAtStart(final)
      if (uuid === 'awaiting' && !final) break
      if (uuid === 'complete') {
        consumeRaw(UUID_SHAPE.length)
        output += '<uuid>'
        continue
      }

      const timestamp = timestampAtStart()
      if (timestamp === 'awaiting' && !final) break
      if (timestamp === 'complete') {
        consumeRaw(TIMESTAMP_SHAPE.length)
        output += '<timestamp>'
        state = { kind: 'timestamp_suffix' }
        continue
      }

      output += consumeRaw(1)
    }
    return output
  }

  return {
    get bufferedBytes() {
      return Buffer.byteLength(pending)
    },
    write(chunk) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      pending += decoder.write(bytes)
      return drain(false)
    },
    end() {
      pending += decoder.end()
      return drain(true)
    },
  }
}

export function scrubValue(value: unknown, options: ScrubOptions = DEFAULT_SCRUB_OPTIONS): unknown {
  if (typeof value === 'string') {
    return scrubString(value, options)
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, options))
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      result[key] = scrubValue(child, options)
    }
    return result
  }
  return value
}
