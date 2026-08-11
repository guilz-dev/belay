export interface NetworkEndpoint {
  host: string
  port?: number
  protocol: string
}

const SUPPORTED_URL_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:'])
const NON_NETWORK_COLON_PREFIXES = new Set(['file', 'link', 'npm', 'workspace'])

export function parseNetworkEndpoint(spec: string): NetworkEndpoint | null {
  const normalized = spec.trim().replace(/^git\+/, '')
  try {
    const url = new URL(normalized)
    if (SUPPORTED_URL_PROTOCOLS.has(url.protocol) && url.hostname) {
      return {
        host: url.hostname,
        ...(url.port ? { port: Number(url.port) } : {}),
        protocol: url.protocol.slice(0, -1),
      }
    }
  } catch {}

  const scpStyle = normalized.match(/^(?:([^@/\s:]+)@)?([^:/\s]+):(.+)$/)
  if (!scpStyle) {
    return null
  }
  const [, user, host, remotePath] = scpStyle
  if (!host || !remotePath || NON_NETWORK_COLON_PREFIXES.has(host.toLowerCase())) {
    return null
  }
  if (
    !user &&
    !host.includes('.') &&
    !remotePath.includes('/') &&
    !/\.git(?:#.*)?$/i.test(remotePath)
  ) {
    return null
  }
  return { host: host.toLowerCase(), protocol: 'ssh' }
}
