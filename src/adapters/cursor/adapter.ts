import path from 'node:path'

import { getManagedHookEntries } from '../../defaults.js'
import { doctorProject } from '../../commands/doctor.js'
import { initCursorProject, upgradeCursorProject } from '../../installer.js'
import type { DoctorOptions, InitOptions, UpgradeOptions } from '../../types.js'
import { cursorLayout } from '../layouts/cursor.js'
import type { BelayAdapter } from '../types.js'

export const cursorAdapter: BelayAdapter = {
  name: 'cursor',
  layout: cursorLayout,

  async install(repoRoot: string, options: InitOptions = {}) {
    return initCursorProject({ ...options, targetDir: repoRoot })
  },

  async upgrade(repoRoot: string, options: UpgradeOptions = {}) {
    return upgradeCursorProject({ ...options, targetDir: repoRoot })
  },

  async doctor(options: DoctorOptions = {}) {
    return doctorProject({ ...options, adapter: 'cursor' })
  },

  hookEvents() {
    return getManagedHookEntries(process.platform)
  },
}

export function cursorPaths(repoRoot: string) {
  const resolved = path.resolve(repoRoot)
  return {
    config: cursorLayout.configPath(resolved),
    hooks: cursorLayout.hooksSettingsPath(resolved),
    runtime: path.join(cursorLayout.runtimeDir(resolved), 'core.mjs'),
  }
}
