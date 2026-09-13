import path from 'node:path'
import type { BelayConfigV4 } from './types.js'

export function defaultControlPlaneDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => env.HOME ?? env.USERPROFILE ?? '',
): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim()
    if (appData) {
      return path.join(appData, 'agent-belay')
    }
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  const base = xdgConfigHome || path.join(homedir(), '.config')
  return path.join(base, 'agent-belay')
}

export function resolveControlPlaneDir(config: BelayConfigV4): string {
  if (config.controlPlane.configDir) {
    return config.controlPlane.configDir
  }
  return defaultControlPlaneDir()
}

/** Control-plane directory regardless of enabled flag (for orphan migration). */
export function configuredControlPlaneDir(config: BelayConfigV4): string {
  return resolveControlPlaneDir(config)
}

export function belayStateDir(config: BelayConfigV4, repoLocalStateDir: string): string {
  if (config.controlPlane.enabled) {
    return resolveControlPlaneDir(config)
  }
  return repoLocalStateDir
}

export function pendingApprovalsFile(config: BelayConfigV4, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'pending-approvals.json')
}

export function approvedApprovalsFile(config: BelayConfigV4, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'approved-approvals.json')
}
