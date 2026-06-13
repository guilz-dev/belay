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
  const hooksDir = path.join(path.resolve(repoRoot), '.cursor', 'hooks')
  return buildRunnerInvocation(platform, hooksDir, repoRoot, hookName, ...args)
}

export const cursorLayout: AdapterLayout = {
  name: 'cursor',

  configPath(repoRoot: string) {
    return path.join(repoRoot, '.cursor', 'belay.config.json')
  },

  hooksSettingsPath(repoRoot: string) {
    return path.join(repoRoot, '.cursor', 'hooks.json')
  },

  hooksDir(repoRoot: string) {
    return path.join(repoRoot, '.cursor', 'hooks')
  },

  runtimeDir(repoRoot: string) {
    return path.join(repoRoot, '.cursor', 'belay', 'runtime')
  },

  repoLocalStateDir(repoRoot: string) {
    return path.join(repoRoot, '.cursor', 'belay')
  },

  defaultAuditLogPath(_repoRoot: string) {
    return path.join('.cursor', 'belay', 'audit.ndjson')
  },

  repoRootMarkers: ['.git', '.cursor'],

  runnerCommand,

  defaultConfig(repoRoot: string) {
    return {
      ...DEFAULT_CONFIG_V4,
      adapter: 'cursor',
      audit: {
        ...DEFAULT_CONFIG_V4.audit,
        logPath: cursorLayout.defaultAuditLogPath(repoRoot),
      },
    }
  },
}
