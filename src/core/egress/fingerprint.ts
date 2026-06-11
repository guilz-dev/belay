import { hashValue } from '../fingerprint.js'

export function egressFingerprint(repoRoot: string, host: string, port: number): string {
  return hashValue(`egress:${repoRoot}:${host.toLowerCase()}:${port}`)
}

export function egressSummary(host: string, port: number, method = 'CONNECT'): string {
  return `${method} ${host.toLowerCase()}:${port}`
}

export function parseHostFromSummary(summary: string): string | null {
  const connectMatch = summary.match(/^(?:CONNECT|GET|POST|PUT|DELETE|HEAD)\s+([^:\s/]+)/i)
  if (connectMatch?.[1]) {
    return connectMatch[1].toLowerCase()
  }
  try {
    const url = new URL(summary.trim())
    return url.hostname.toLowerCase()
  } catch {
    return null
  }
}
