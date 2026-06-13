import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { doctorProject } from '../../commands/doctor.js'
import { mergeAndWriteConfig } from '../../config-io.js'
import { runtimeIntegrityFiles, writeIntegrityManifest } from '../../core/integrity.js'
import { bootstrapStateFiles, writeSkillArtifacts } from '../../installer/bootstrap.js'
import { writeRuntimeArtifacts } from '../../installer/runtime-artifacts.js'
import { applyInstallScope, resolveOperationScope } from '../../installer/scope-config.js'
import type { DoctorOptions, InitOptions, UpgradeOptions } from '../../types.js'
import { codexLayout } from '../layouts/codex.js'
import { resolveScopedPaths } from '../layouts/scope.js'
import type { BelayAdapter } from '../types.js'
import { getCodexManagedHookEntries, mergeCodexHooksToml } from './hooks.js'

async function loadCodexConfigToml(configTomlPath: string): Promise<string> {
  if (!existsSync(configTomlPath)) {
    return ''
  }
  return readFile(configTomlPath, 'utf8')
}

async function writeCodexHooksConfig(
  paths: ReturnType<typeof resolveScopedPaths>,
  repoRoot: string,
): Promise<void> {
  const configTomlPath = paths.hooksSettingsPath
  const existing = await loadCodexConfigToml(configTomlPath)
  const merged = mergeCodexHooksToml(existing, process.platform, paths.hooksDir, repoRoot)
  await mkdir(path.dirname(configTomlPath), { recursive: true })
  await writeFile(configTomlPath, merged, 'utf8')
}

async function installCodexBase(repoRoot: string, options: InitOptions): Promise<void> {
  const scope = await resolveOperationScope(repoRoot, 'codex', options)
  const paths = resolveScopedPaths(codexLayout, scope, repoRoot)
  const config = await mergeAndWriteConfig(repoRoot, 'codex')
  await applyInstallScope(repoRoot, 'codex', scope, config)

  await writeRuntimeArtifacts('codex', paths)
  await bootstrapStateFiles(repoRoot, config, paths)

  if (options.withSkill) {
    await writeSkillArtifacts('codex', paths)
  }

  await writeCodexHooksConfig(paths, repoRoot)
  await writeIntegrityManifest(repoRoot, codexLayout, runtimeIntegrityFiles(codexLayout, paths))
}

export const codexAdapter: BelayAdapter = {
  name: 'codex',
  layout: codexLayout,

  async install(repoRoot: string, options: InitOptions = {}) {
    await installCodexBase(repoRoot, options)
    return { repoRoot, withSkill: options.withSkill === true }
  },

  async upgrade(repoRoot: string, options: UpgradeOptions = {}) {
    const scope = await resolveOperationScope(repoRoot, 'codex', options)
    const paths = resolveScopedPaths(codexLayout, scope, repoRoot)
    const config = await mergeAndWriteConfig(repoRoot, 'codex')
    await applyInstallScope(repoRoot, 'codex', scope, config)
    await writeRuntimeArtifacts('codex', paths)
    await writeCodexHooksConfig(paths, repoRoot)
    if (options.withSkill) {
      await writeSkillArtifacts('codex', paths)
    }
    await writeIntegrityManifest(repoRoot, codexLayout, runtimeIntegrityFiles(codexLayout, paths))
    return { repoRoot }
  },

  async doctor(options: DoctorOptions = {}) {
    return doctorProject({ ...options, adapter: 'codex' })
  },

  hookEvents() {
    return getCodexManagedHookEntries(process.platform)
  },
}

export function codexPaths(repoRoot: string) {
  const resolved = path.resolve(repoRoot)
  return {
    config: codexLayout.configPath(resolved),
    hooks: codexLayout.hooksSettingsPath(resolved),
    runtime: path.join(codexLayout.runtimeDir(resolved), 'core.mjs'),
  }
}
