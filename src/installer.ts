import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  hasManagedCursorHookEntries,
  mergeCursorHooksFile,
  stripCursorHooksFile,
} from './adapters/cursor/hooks.js'
import { cursorLayout } from './adapters/layouts/cursor.js'
import { resolveScopedPaths, type ScopedPaths } from './adapters/layouts/scope.js'
import type { AdapterName } from './adapters/layouts/types.js'
import { getAdapter } from './adapters/registry.js'
import { dogfoodProject } from './commands/dogfood.js'
import {
  detectAdapterName,
  loadConfigFile,
  mergeAndWriteConfig,
  writeTrustedConfigFile,
} from './config-io.js'
import { appendCliAuditEvent } from './core/audit-io.js'
import { archiveLegacyAuditLogIfNeeded } from './core/audit-legacy-archive.js'
import {
  type BelayJudgeConfig,
  isFreshConfigInput,
  mergeConfig,
  normalizeConfig,
} from './core/config.js'
import { runtimeIntegrityFiles, writeIntegrityManifest } from './core/integrity.js'
import {
  hasValidCloudConsent,
  isCloudJudgeConfig,
  migrateImplicitLocalJudgeIfNeeded,
  resolveInitJudgeConfig,
} from './core/judge-config.js'
import { resolveJudgeTransport } from './core/judge-runtime-detection.js'
import {
  bootstrapStateFiles,
  CURSOR_COMMAND_ARTIFACTS,
  writeSkillArtifacts,
} from './installer/bootstrap.js'
import { writeRuntimeArtifacts } from './installer/runtime-artifacts.js'
import { applyInstallScope, resolveOperationScope } from './installer/scope-config.js'
import { applyConfigPreset } from './presets.js'
import type { HooksFile, InitOptions, UninstallOptions, UpgradeOptions } from './types.js'

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
  await writeRuntimeArtifacts('cursor', paths)
  await bootstrapStateFiles(repoRoot, config, paths)

  if (withSkill) {
    await writeSkillArtifacts('cursor', paths)
  }

  await mkdir(path.dirname(paths.hooksSettingsPath), { recursive: true })
  await writeFile(paths.hooksSettingsPath, `${JSON.stringify(mergedHooks, null, 2)}\n`, 'utf8')
  const installedConfig = await applyInstallScope(repoRoot, 'cursor', scope, config)
  if (scope === 'global') {
    await cleanupStaleProjectCursorInstall(repoRoot)
  }
  await writeIntegrityManifest(repoRoot, cursorLayout, runtimeIntegrityFiles(cursorLayout, paths))
  await archiveLegacyAuditLogIfNeeded(repoRoot, installedConfig)
  return { repoRoot, withSkill }
}

export async function upgradeCursorProject(
  options: UpgradeOptions = {},
): Promise<{ repoRoot: string }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const scope = await resolveOperationScope(repoRoot, 'cursor', options)
  const paths = resolveScopedPaths(cursorLayout, scope, repoRoot)

  const config = await mergeAndWriteConfig(repoRoot, 'cursor')
  await writeRuntimeArtifacts('cursor', paths)

  const hooksFile = await loadHooksFile(paths.hooksSettingsPath)
  const merged = mergeCursorHooksFile(hooksFile, process.platform, paths.hooksDir, repoRoot)
  await mkdir(path.dirname(paths.hooksSettingsPath), { recursive: true })
  await writeFile(paths.hooksSettingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

  if (scope === 'project') {
    const globalPaths = resolveScopedPaths(cursorLayout, 'global', repoRoot)
    if (existsSync(globalPaths.hooksSettingsPath)) {
      const globalHooks = await loadHooksFile(globalPaths.hooksSettingsPath)
      if (
        hasManagedCursorHookEntries(globalHooks, process.platform, globalPaths.hooksDir, repoRoot)
      ) {
        await writeRuntimeArtifacts('cursor', globalPaths)
        const mergedGlobal = mergeCursorHooksFile(
          globalHooks,
          process.platform,
          globalPaths.hooksDir,
          repoRoot,
        )
        await writeFile(
          globalPaths.hooksSettingsPath,
          `${JSON.stringify(mergedGlobal, null, 2)}\n`,
          'utf8',
        )
      }
    }
  }

  if (options.withSkill) {
    await writeSkillArtifacts('cursor', paths)
  }

  const installedConfig = await applyInstallScope(repoRoot, 'cursor', scope, config)
  if (scope === 'global') {
    await cleanupStaleProjectCursorInstall(repoRoot)
  }

  await writeIntegrityManifest(repoRoot, cursorLayout, runtimeIntegrityFiles(cursorLayout, paths))
  await archiveLegacyAuditLogIfNeeded(repoRoot, installedConfig)
  return { repoRoot }
}

const BELAY_HOOK_ARTIFACTS = [
  'belay-before-submit.mjs',
  'belay-shell-gate.mjs',
  'belay-tool-gate.mjs',
  'belay-audit.mjs',
  'belay-runner',
  'belay-runner.cmd',
  'belay-runner.ps1',
]

async function removeBelayHookArtifacts(paths: ScopedPaths): Promise<void> {
  for (const fileName of BELAY_HOOK_ARTIFACTS) {
    await rm(path.join(paths.hooksDir, fileName), { force: true })
  }
  for (const fileName of ['core.mjs', 'dispatcher.mjs']) {
    await rm(path.join(paths.runtimeDir, fileName), { force: true })
  }
  await rm(path.join(paths.skillsDir, 'SKILL.md'), { force: true })
  if (paths.commandsDir) {
    for (const fileName of CURSOR_COMMAND_ARTIFACTS) {
      await rm(path.join(paths.commandsDir, fileName), { force: true })
    }
  }
}

async function cleanupStaleProjectCursorInstall(repoRoot: string): Promise<void> {
  const projectPaths = resolveScopedPaths(cursorLayout, 'project', repoRoot)
  if (!existsSync(projectPaths.hooksSettingsPath)) {
    return
  }
  const projectHooks = await loadHooksFile(projectPaths.hooksSettingsPath)
  if (
    !hasManagedCursorHookEntries(projectHooks, process.platform, projectPaths.hooksDir, repoRoot)
  ) {
    return
  }
  const stripped = stripCursorHooksFile(
    projectHooks,
    process.platform,
    projectPaths.hooksDir,
    repoRoot,
  )
  await writeFile(projectPaths.hooksSettingsPath, `${JSON.stringify(stripped, null, 2)}\n`, 'utf8')
  await removeBelayHookArtifacts(projectPaths)
}

export async function uninstallCursorProject(
  options: UninstallOptions = {},
): Promise<{ repoRoot: string; scope: 'project' | 'global' }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const scope = await resolveOperationScope(repoRoot, 'cursor', options)
  const paths = resolveScopedPaths(cursorLayout, scope, repoRoot)
  const hooksSettingsExisted = existsSync(paths.hooksSettingsPath)
  const hooksFile = await loadHooksFile(paths.hooksSettingsPath)
  const stripped = stripCursorHooksFile(hooksFile, process.platform, paths.hooksDir, repoRoot)

  if (hooksSettingsExisted) {
    await mkdir(path.dirname(paths.hooksSettingsPath), { recursive: true })
    await writeFile(paths.hooksSettingsPath, `${JSON.stringify(stripped, null, 2)}\n`, 'utf8')
  }
  await removeBelayHookArtifacts(paths)

  return { repoRoot, scope }
}

function resolveAdapterName(
  options: InitOptions | UpgradeOptions | UninstallOptions,
  repoRoot?: string,
): AdapterName {
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

async function auditJudgeMigrationIfNeeded(
  repoRoot: string,
  adapterName: AdapterName,
  before: BelayJudgeConfig,
  after: BelayJudgeConfig,
  by: string,
): Promise<void> {
  if (before.providerId === after.providerId && before.provider === after.provider) {
    return
  }
  const config = await loadConfigFile(repoRoot, adapterName)
  await appendCliAuditEvent(repoRoot, config, {
    event: 'judge_provider_changed',
    from: { providerId: before.providerId, provider: before.provider },
    to: { providerId: after.providerId, provider: after.provider },
    by,
  })
}

async function applyInitJudgeConfig(
  repoRoot: string,
  adapterName: AdapterName,
  options: InitOptions,
  isFreshBeforeInstall: boolean,
): Promise<void> {
  if (options.skipJudgeWrite) {
    return
  }
  const mergedConfig = await loadConfigFile(repoRoot, adapterName)
  const hasExplicitJudgeFlags =
    options.judgeProfile ||
    options.judgeProvider ||
    options.judgeProviderId ||
    options.judgeModel ||
    options.judgeEndpoint
  const judge = resolveInitJudgeConfig({
    isFresh: isFreshBeforeInstall,
    hasExplicitJudgeFlags: Boolean(hasExplicitJudgeFlags),
    judgeProfile: options.judgeProfile,
    judgeProvider: options.judgeProvider,
    judgeProviderId: options.judgeProviderId,
    judgeModel: options.judgeModel,
    judgeEndpoint: options.judgeEndpoint,
    acceptCloudJudge: options.acceptCloudJudge,
    interactiveConsent: Boolean(options.acceptCloudJudge && process.stdin.isTTY),
    cloudConsentApprovalId: options.cloudConsentApprovalId,
    existingJudge: mergedConfig.judge,
    adapter: adapterName,
  })
  const migrated =
    options.migrateJudgeDefault === true
      ? migrateImplicitLocalJudgeIfNeeded(mergedConfig.judge, adapterName)
      : null
  let finalJudge = migrated ?? judge
  if (options.judgeCredentialMode) {
    finalJudge = {
      ...finalJudge,
      credential:
        options.judgeCredentialMode === 'apiKey'
          ? { mode: 'apiKey', ref: 'store:judge' }
          : { mode: 'project' },
    }
  }
  const configWithJudge = normalizeConfig({ ...mergedConfig, version: 4, judge: finalJudge })
  if (
    isCloudJudgeConfig(configWithJudge.judge) &&
    resolveJudgeTransport(configWithJudge.judge) === 'http' &&
    !hasValidCloudConsent(configWithJudge.judge)
  ) {
    process.stderr.write(
      'Warning: Cloud judge saved without recorded consent. Tier1 cloud judge will fail closed until consent is granted (belay judge consent + belay approve, or TTY --accept-cloud-judge).\n',
    )
  }
  await writeTrustedConfigFile(repoRoot, configWithJudge, adapterName)
  if (migrated) {
    await auditJudgeMigrationIfNeeded(
      repoRoot,
      adapterName,
      mergedConfig.judge,
      finalJudge,
      options.migrateJudgeDefault ? 'belay init --migrate-judge-default' : 'belay init',
    )
  }
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
  const configPath = adapter.layout.configPath(repoRoot)
  let isFreshBeforeInstall = true
  if (await pathExists(configPath)) {
    try {
      const raw = await readFile(configPath, 'utf8')
      isFreshBeforeInstall = isFreshConfigInput(JSON.parse(raw))
    } catch {
      isFreshBeforeInstall = false
    }
  }
  const result = await adapter.install(repoRoot, options)
  await applyInitJudgeConfig(repoRoot, adapterName, options, isFreshBeforeInstall)
  if (options.preset) {
    const existing = await loadConfigFile(repoRoot, adapterName)
    const presetConfig = mergeConfig(applyConfigPreset(options.preset))
    const merged = mergeConfig(presetConfig, existing)
    await writeTrustedConfigFile(repoRoot, merged, adapterName)
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
  if (options.migrateJudgeDefault === true) {
    const mergedConfig = await loadConfigFile(repoRoot, adapterName)
    const migrated = migrateImplicitLocalJudgeIfNeeded(mergedConfig.judge, adapterName)
    if (migrated) {
      const configWithJudge = normalizeConfig({ ...mergedConfig, version: 4, judge: migrated })
      await writeTrustedConfigFile(repoRoot, configWithJudge, adapterName)
      await auditJudgeMigrationIfNeeded(
        repoRoot,
        adapterName,
        mergedConfig.judge,
        migrated,
        'belay upgrade --migrate-judge-default',
      )
    }
  }
  await refreshIntegrityManifest(repoRoot, adapterName)
  return { repoRoot, adapter: adapterName }
}

export async function uninstallProject(
  options: UninstallOptions = {},
): Promise<{ repoRoot: string; adapter: AdapterName; scope: 'project' | 'global' }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const adapterName = resolveAdapterName(options, repoRoot)
  if (adapterName !== 'cursor') {
    throw new Error(
      `belay uninstall is only supported for Cursor adapter today. Use --adapter cursor or uninstall hooks manually for ${adapterName}.`,
    )
  }
  const result = await uninstallCursorProject({ ...options, targetDir: repoRoot })
  return { repoRoot: result.repoRoot, adapter: adapterName, scope: result.scope }
}
