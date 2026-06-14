import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { mergeCursorHooksFile } from './adapters/cursor/hooks.js'
import { cursorLayout } from './adapters/layouts/cursor.js'
import { resolveScopedPaths } from './adapters/layouts/scope.js'
import type { AdapterName } from './adapters/layouts/types.js'
import { getAdapter } from './adapters/registry.js'
import { dogfoodProject } from './commands/dogfood.js'
import {
  detectAdapterName,
  loadConfigFile,
  mergeAndWriteConfig,
  writeConfigFile,
} from './config-io.js'
import { isFreshConfigInput, mergeConfig, normalizeConfig } from './core/config.js'
import { runtimeIntegrityFiles, writeIntegrityManifest } from './core/integrity.js'
import { resolveInitJudgeConfig } from './core/judge-config.js'
import { bootstrapStateFiles, writeSkillArtifacts } from './installer/bootstrap.js'
import { writeRuntimeArtifacts } from './installer/runtime-artifacts.js'
import { applyInstallScope, resolveOperationScope } from './installer/scope-config.js'
import { applyConfigPreset } from './presets.js'
import type { HooksFile, InitOptions, UpgradeOptions } from './types.js'

export type { InstallScope } from './adapters/layouts/scope.js'

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

export async function loadHooksFile(hooksPath: string): Promise<HooksFile> {
  if (!existsSync(hooksPath)) {
    return { version: 1, hooks: {} }
  }
  const raw = await readFile(hooksPath, 'utf8')
  try {
    const parsed = JSON.parse(raw) as HooksFile
    if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number') {
      throw new Error('hooks.json must contain a numeric version field.')
    }
    if (!parsed.hooks || typeof parsed.hooks !== 'object') {
      throw new Error('hooks.json must contain an object hooks field.')
    }
    return parsed
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown JSON parse failure.'
    throw new Error(`Invalid hooks.json at ${hooksPath}: ${detail}`)
  }
}

export function mergeHooksFile(
  current: HooksFile,
  platform: NodeJS.Platform = process.platform,
  hooksDir?: string,
  repoRoot?: string,
): HooksFile {
  const resolvedRepo = path.resolve(repoRoot ?? process.cwd())
  const resolvedHooksDir = hooksDir ?? cursorLayout.hooksDir(resolvedRepo)
  return mergeCursorHooksFile(current, platform, resolvedHooksDir, resolvedRepo)
}

export async function initCursorProject(
  options: InitOptions = {},
): Promise<{ repoRoot: string; withSkill: boolean }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const scope = await resolveOperationScope(repoRoot, 'cursor', options)
  const paths = resolveScopedPaths(cursorLayout, scope, repoRoot)
  const withSkill = options.withSkill === true
  const hooksFile = await loadHooksFile(paths.hooksSettingsPath)
  const mergedHooks = mergeCursorHooksFile(hooksFile, process.platform, paths.hooksDir, repoRoot)

  await ensureDir(paths.hooksDir)
  const config = await mergeAndWriteConfig(repoRoot, 'cursor')
  await applyInstallScope(repoRoot, 'cursor', scope, config)
  await writeRuntimeArtifacts('cursor', paths)
  await bootstrapStateFiles(repoRoot, config, paths)

  if (withSkill) {
    await writeSkillArtifacts('cursor', paths)
  }

  await mkdir(path.dirname(paths.hooksSettingsPath), { recursive: true })
  await writeFile(paths.hooksSettingsPath, `${JSON.stringify(mergedHooks, null, 2)}\n`, 'utf8')
  await writeIntegrityManifest(repoRoot, cursorLayout, runtimeIntegrityFiles(cursorLayout, paths))
  return { repoRoot, withSkill }
}

export async function upgradeCursorProject(
  options: UpgradeOptions = {},
): Promise<{ repoRoot: string }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const scope = await resolveOperationScope(repoRoot, 'cursor', options)
  const paths = resolveScopedPaths(cursorLayout, scope, repoRoot)

  const config = await mergeAndWriteConfig(repoRoot, 'cursor')
  await applyInstallScope(repoRoot, 'cursor', scope, config)
  await writeRuntimeArtifacts('cursor', paths)

  const hooksFile = await loadHooksFile(paths.hooksSettingsPath)
  const merged = mergeCursorHooksFile(hooksFile, process.platform, paths.hooksDir, repoRoot)
  await mkdir(path.dirname(paths.hooksSettingsPath), { recursive: true })
  await writeFile(paths.hooksSettingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

  if (options.withSkill) {
    await writeSkillArtifacts('cursor', paths)
  }

  await writeIntegrityManifest(repoRoot, cursorLayout, runtimeIntegrityFiles(cursorLayout, paths))
  return { repoRoot }
}

function resolveAdapterName(options: InitOptions | UpgradeOptions, repoRoot?: string): AdapterName {
  if (options.adapter === 'claude') {
    return 'claude'
  }
  if (options.adapter === 'codex') {
    return 'codex'
  }
  if (options.adapter === 'cursor') {
    return 'cursor'
  }
  if (repoRoot) {
    return detectAdapterName(repoRoot)
  }
  return 'cursor'
}

async function applyInitJudgeConfig(
  repoRoot: string,
  adapterName: AdapterName,
  options: InitOptions,
): Promise<void> {
  if (options.skipJudgeWrite) {
    return
  }
  const layout = getAdapter(adapterName).layout
  const configPath = layout.configPath(repoRoot)
  let existingConfig: unknown = {}
  if (await pathExists(configPath)) {
    existingConfig = JSON.parse(await readFile(configPath, 'utf8'))
  }
  const isFresh = isFreshConfigInput(existingConfig)
  const mergedConfig = await loadConfigFile(repoRoot, adapterName)
  const hasExplicitJudgeFlags =
    options.judgeProfile || options.judgeProvider || options.judgeModel || options.judgeEndpoint
  const judge = resolveInitJudgeConfig({
    isFresh,
    hasExplicitJudgeFlags: Boolean(hasExplicitJudgeFlags),
    judgeProfile: options.judgeProfile,
    judgeProvider: options.judgeProvider,
    judgeModel: options.judgeModel,
    judgeEndpoint: options.judgeEndpoint,
    acceptCloudJudge: options.acceptCloudJudge,
    existingJudge: mergedConfig.judge,
    defaultJudgeProfile: adapterName,
  })
  const configWithJudge = normalizeConfig({ ...mergedConfig, version: 4, judge })
  await writeConfigFile(repoRoot, configWithJudge, adapterName)
}

async function refreshIntegrityManifest(repoRoot: string, adapterName: AdapterName): Promise<void> {
  const layout = getAdapter(adapterName).layout
  const config = await loadConfigFile(repoRoot, adapterName)
  const scope = config.installScope === 'global' ? 'global' : 'project'
  const paths = resolveScopedPaths(layout, scope, repoRoot)
  await writeIntegrityManifest(repoRoot, layout, runtimeIntegrityFiles(layout, paths))
}

export async function initProject(
  options: InitOptions = {},
): Promise<{ repoRoot: string; withSkill: boolean; dogfood: boolean; adapter: AdapterName }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const adapterName = resolveAdapterName(options, repoRoot)
  const adapter = getAdapter(adapterName)
  const result = await adapter.install(repoRoot, options)
  await applyInitJudgeConfig(repoRoot, adapterName, options)
  if (options.preset) {
    const existing = await loadConfigFile(repoRoot, adapterName)
    const presetConfig = mergeConfig(applyConfigPreset(options.preset))
    const merged = mergeConfig(presetConfig, existing)
    await writeConfigFile(repoRoot, merged, adapterName)
  }
  if (options.dogfood === true) {
    await dogfoodProject({ targetDir: repoRoot, adapter: adapterName })
  }
  await refreshIntegrityManifest(repoRoot, adapterName)
  return {
    repoRoot,
    withSkill: result.withSkill,
    dogfood: options.dogfood === true,
    adapter: adapterName,
  }
}

export async function upgradeProject(
  options: UpgradeOptions = {},
): Promise<{ repoRoot: string; adapter: AdapterName }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const adapterName = resolveAdapterName(options, repoRoot)
  await getAdapter(adapterName).upgrade(repoRoot, options)
  await refreshIntegrityManifest(repoRoot, adapterName)
  return { repoRoot, adapter: adapterName }
}
