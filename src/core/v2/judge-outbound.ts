import { matchesSensitivePath } from '../glob.js'
import { scrubString } from '../scrub.js'
import type { ScrubOptions } from '../types.js'

const PATH_LIKE =
  /(?:^|[\s"'`=])(~\/[^\s"'`]+|\/[^\s"'`]+|\.\/[^\s"'`]+|\.\.\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g

const REDACTED_PLACEHOLDER = /^(?:<redacted>|\[REDACTED\]|<secret>|<high-entropy>|<approval-id>)$/i
const URL_CREDENTIALS_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/\s:@]+):([^@\s/]+)@/gi
const GENERIC_AUTH_HEADER_PATTERN =
  /\b(?:Authorization|X-Api-Key|X-Auth-Token|Private-Token):\s*([^\s]+)/gi

function hasResidualBearerToken(text: string): boolean {
  for (const match of text.matchAll(/\bBearer\s+(\S+)/gi)) {
    const token = match[1] ?? ''
    if (!REDACTED_PLACEHOLDER.test(token)) {
      return true
    }
  }
  return false
}

function hasResidualApiKey(text: string): boolean {
  return /\bsk-(?![^\s]*<redacted>)[A-Za-z0-9_-]{4,}/i.test(text)
}

function hasResidualUrlCredentials(text: string): boolean {
  for (const match of text.matchAll(URL_CREDENTIALS_PATTERN)) {
    const username = (match[1] ?? '').replace(/^['"]|['"]$/g, '')
    const password = (match[2] ?? '').replace(/^['"]|['"]$/g, '')
    if (!REDACTED_PLACEHOLDER.test(username) || !REDACTED_PLACEHOLDER.test(password)) {
      return true
    }
  }
  return false
}

function hasResidualAuthHeader(text: string): boolean {
  for (const match of text.matchAll(GENERIC_AUTH_HEADER_PATTERN)) {
    const token = (match[1] ?? '').replace(/^['"]|['"]$/g, '')
    if (!REDACTED_PLACEHOLDER.test(token)) {
      return true
    }
  }
  return false
}

export interface OutboundScrubOptions {
  sensitivePaths: string[]
  scrubOptions: ScrubOptions
}

function redactSensitivePathToken(token: string, sensitivePaths: string[]): string {
  const trimmed = token.replace(/^['"`]+|['"`]+$/g, '')
  const normalized = trimmed.replaceAll('\\', '/')
  if (!matchesSensitivePath(normalized, sensitivePaths)) {
    return token
  }
  const segments = normalized.split('/')
  const basename = segments.at(-1) ?? normalized
  if (segments.length > 1) {
    return token.replace(basename, '[REDACTED]')
  }
  return '[REDACTED]'
}

export function scrubOutboundForJudge(
  text: string,
  options: OutboundScrubOptions,
): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    let scrubbed = scrubString(text, {
      ...options.scrubOptions,
      maskHighEntropyStrings: options.scrubOptions.maskHighEntropyStrings !== false,
    })

    scrubbed = scrubbed.replace(PATH_LIKE, (match, pathToken: string) => {
      const redacted = redactSensitivePathToken(pathToken, options.sensitivePaths)
      return match.replace(pathToken, redacted)
    })

    if (
      hasResidualApiKey(scrubbed) ||
      hasResidualBearerToken(scrubbed) ||
      hasResidualUrlCredentials(scrubbed) ||
      hasResidualAuthHeader(scrubbed)
    ) {
      return { ok: false, reason: 'residual_secret_detected' }
    }

    return { ok: true, text: scrubbed }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'scrub_failed'
    return { ok: false, reason }
  }
}
