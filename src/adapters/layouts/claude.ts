import path from 'node:path'

import { DEFAULT_CONFIG_V3 } from '../../core/config.js'
import type { AdapterLayout } from './types.js'

function runnerCommand(platform: NodeJS.Platform, hookName: string, ...args: string[]): string {
  const base =
    platform === 'win32' ? '.\\.claude\\hooks\\belay-runner.cmd' : './.claude/hooks/belay-runner'
  return [base, hookName, ...args].join(' ')
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
      ...DEFAULT_CONFIG_V3,
      adapter: 'claude',
      audit: {
        ...DEFAULT_CONFIG_V3.audit,
        logPath: claudeLayout.defaultAuditLogPath(repoRoot),
      },
    }
  },
}
