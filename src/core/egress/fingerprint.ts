import { hashValue } from '../fingerprint.js'

export function egressFingerprint(repoRoot: string, host: string, port: number): string {
  return hashValue(`egress:${repoRoot}:${host.toLowerCase()}:${port}`)
}

function formatHostPort(host: string, port: number): string {
  const normalized = host.toLowerCase()
  const hostLabel = normalized.includes(':') ? `[${normalized}]` : normalized
  return `${hostLabel}:${port}`
}

export function egressSummary(host: string, port: number, method = 'CONNECT'): string {
  return `${method} ${formatHostPort(host, port)}`
}

export function parseHostFromSummary(summary: string): string | null {
  const trimmed = summary.trim()
  const methodMatch = trimmed.match(/^(CONNECT|GET|POST|PUT|DELETE|HEAD|PATCH|OPTIONS)\s+(.+)$/i)
  if (!methodMatch?.[2]) {
    try {
      return new URL(trimmed).hostname.toLowerCase()
    } catch {
      return null
    }
  }

  const target = methodMatch[2].trim()
  const bracketMatch = target.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketMatch?.[1]) {
    return bracketMatch[1].toLowerCase()
  }

  const colonIndex = target.lastIndexOf(':')
  if (colonIndex > 0) {
    return target.slice(0, colonIndex).toLowerCase()
  }

  return target.toLowerCase()
}
