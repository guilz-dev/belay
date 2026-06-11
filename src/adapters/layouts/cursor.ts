import path from 'node:path'

import { DEFAULT_CONFIG_V3 } from '../../core/config.js'
import type { AdapterLayout } from './types.js'

function runnerCommand(platform: NodeJS.Platform, hookName: string, ...args: string[]): string {
  const base =
    platform === 'win32' ? '.\\.cursor\\hooks\\belay-runner.cmd' : './.cursor/hooks/belay-runner'
  return [base, hookName, ...args].join(' ')
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
      ...DEFAULT_CONFIG_V3,
      adapter: 'cursor',
      audit: {
        ...DEFAULT_CONFIG_V3.audit,
        logPath: cursorLayout.defaultAuditLogPath(repoRoot),
      },
    }
  },
}
