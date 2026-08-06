import type { BelayConfigV4 } from '../config.js'
import { recommendedProxyEnv } from '../egress/env.js'

export function isEgressProxyActive(params: {
  config: BelayConfigV4
  running: boolean
  foreignProxy?: boolean
  repoRootMismatch?: boolean
}): boolean {
  if (!params.config.egress.enabled) {
    return false
  }
  return params.running && !params.foreignProxy && !params.repoRootMismatch
}

export function egressProxyEnvFromConfig(
  config: BelayConfigV4,
  proxyActive: boolean,
): Record<string, string> {
  if (!proxyActive || !config.egress.enabled) {
    return {}
  }
  return recommendedProxyEnv(config.egress)
}

export function dockerEnvArgs(proxyEnv: Record<string, string>): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(proxyEnv)) {
    args.push('-e', `${key}=${value}`)
  }
  return args
}
