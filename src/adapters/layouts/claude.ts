import path from 'node:path'

import { DEFAULT_CONFIG_V4 } from '../../core/config.js'
import { buildRunnerInvocation } from './scope.js'
import type { AdapterLayout } from './types.js'

function runnerCommand(
  platform: NodeJS.Platform,
  repoRoot: string,
  hookName: string,
  ...args: string[]
): string {
  const hooksDir = path.join(path.resolve(repoRoot), '.claude', 'hooks')
  return buildRunnerInvocation(platform, hooksDir, repoRoot, hookName, ...args)
}

export const claudeLayout: AdapterLayout = {
  name: 'claude',

  configPath(repoRoot: string) {
    return path.join(repoRoot, '.claude', 'belay.config.json')
  },

  hooksSettingsPath(repoRoot: string) {
    return path.join(repoRoot, '.claude', 'settings.json')
  },

  hooksDir(repoRoot: string) {
    return path.join(repoRoot, '.claude', 'hooks')
  },

  runtimeDir(repoRoot: string) {
    return path.join(repoRoot, '.claude', 'belay', 'runtime')
  },

  repoLocalStateDir(repoRoot: string) {
    return path.join(repoRoot, '.claude', 'belay')
  },

  defaultAuditLogPath(_repoRoot: string) {
    return path.join('.claude', 'belay', 'audit.ndjson')
  },

  repoRootMarkers: ['.git', '.claude'],

  runnerCommand,

  defaultConfig(repoRoot: string) {
    return {
      ...DEFAULT_CONFIG_V4,
      adapter: 'claude',
      audit: {
        ...DEFAULT_CONFIG_V4.audit,
        logPath: claudeLayout.defaultAuditLogPath(repoRoot),
      },
    }
  },
}
