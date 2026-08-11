export interface NetworkEndpoint {
  host: string
  port?: number
  protocol: string
}

const SUPPORTED_URL_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:'])
const NON_NETWORK_COLON_PREFIXES = new Set([
  'catalog',
  'exec',
  'file',
  'link',
  'npm',
  'patch',
  'portal',
  'workspace',
])
const HOSTED_GIT_PREFIXES: Record<string, string> = {
  bitbucket: 'bitbucket.org',
  github: 'github.com',
  gitlab: 'gitlab.com',
}

export interface NetworkEndpointParseOptions {
  allowHostedGitShorthand?: boolean
  allowScpStyle?: boolean
}

export function parseNetworkEndpoint(
  spec: string,
  options: NetworkEndpointParseOptions = {},
): NetworkEndpoint | null {
  const normalized = spec.trim().replace(/^git\+/, '')
  if (options.allowHostedGitShorthand) {
    const hostedGit = normalized.match(/^([a-z]+):(.+)$/i)
    const hostedGitHost = hostedGit?.[1]
      ? HOSTED_GIT_PREFIXES[hostedGit[1].toLowerCase()]
      : undefined
    if (hostedGitHost && hostedGit?.[2]) {
      return { host: hostedGitHost, protocol: 'git' }
    }
  }
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

  if (!options.allowScpStyle || /^[A-Za-z]:[\\/]/.test(normalized)) {
    return null
  }

  const scpStyle = normalized.match(/^(?:([^@/\s:]+)@)?([^:/\s]+):(.+)$/)
  if (!scpStyle) {
    return null
  }
  const [, , host, remotePath] = scpStyle
  if (!host || !remotePath || NON_NETWORK_COLON_PREFIXES.has(host.toLowerCase())) {
    return null
  }
  return { host: host.toLowerCase(), protocol: 'ssh' }
}
