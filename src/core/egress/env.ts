import type { BelayEgressConfig } from '../config.js'

export function recommendedProxyEnv(egress: BelayEgressConfig): Record<string, string> {
  const proxyUrl = `http://${egress.listenHost}:${egress.listenPort}`
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

export function formatProxyEnv(egress: BelayEgressConfig): string {
  const vars = recommendedProxyEnv(egress)
  return Object.entries(vars)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
}
