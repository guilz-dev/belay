import path from 'node:path'
import { getManagedHookEntries } from '../../defaults.js'
import { doctorProject } from '../../doctor.js'
import { initProject, upgradeProject } from '../../installer.js'
import type { DoctorOptions, InitOptions, UpgradeOptions } from '../../types.js'
import type { BelayAdapter } from '../types.js'

export const cursorAdapter: BelayAdapter = {
  name: 'cursor',

  async install(repoRoot: string, options: InitOptions = {}) {
    return initProject({ ...options, targetDir: repoRoot })
  },

  async upgrade(repoRoot: string, options: UpgradeOptions = {}) {
    return upgradeProject({ ...options, targetDir: repoRoot })
  },

  async doctor(options: DoctorOptions = {}) {
    return doctorProject(options)
  },

  hookEvents() {
    return getManagedHookEntries(process.platform)
  },
}

export function cursorPaths(repoRoot: string) {
  const resolved = path.resolve(repoRoot)
  return {
    config: path.join(resolved, '.cursor', 'belay.config.json'),
    hooks: path.join(resolved, '.cursor', 'hooks.json'),
    runtime: path.join(resolved, '.cursor', 'belay', 'runtime', 'core.mjs'),
  }
}
