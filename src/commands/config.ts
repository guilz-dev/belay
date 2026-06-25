import path from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import readline from 'node:readline/promises'

import {
  loadConfigFile,
  repoLocalStateDirFor,
  resolveAdapterName,
  writeConfigFile,
} from '../config-io.js'
import { appendCliAuditEvent } from '../core/audit-io.js'
import type { BelayConfigV4, BelayJudgeConfig, JudgeCredentialRef } from '../core/config.js'
import { belayStateDir, normalizeJudgeConfig } from '../core/config.js'
import { clearJudgeCredentialStore, writeJudgeCredentialStore } from '../core/credential-store.js'
import { refreshIntegrityIfPinned } from '../core/integrity.js'
import {
  defaultJudgeProviderForAdapter,
  hasValidCloudConsent,
  isCloudJudgeConfig,
  resolveJudgeUsePatch,
} from '../core/judge-config.js'
import { rejectDeprecatedJudgeModelAuto } from '../core/judge-model-policy.js'
import { resolveJudgeTransport } from '../core/judge-runtime-detection.js'
import {
  isJudgeProviderId,
  JUDGE_PROVIDER_IDS,
  type JudgeProviderId,
  normalizeLegacyProviderId,
} from '../core/verdict/judge-catalog.js'
import { initProject } from '../installer.js'
import type { AdapterName, InitOptions } from '../types.js'
import { isBelayFloorInstalled } from './health-snapshot.js'
import { judgeStatus } from './judge.js'
import { readKeyFromStdin } from './stdin-key.js'

export const BELAY_CONFIG_SUBCOMMANDS = [
  'list',
  'get',
  'set',
  'unset',
  'credential',
  'judge',
] as const

export type BelayConfigSubcommand = (typeof BELAY_CONFIG_SUBCOMMANDS)[number]

const JUDGE_CONFIG_PATHS = [
  'judge.providerId',
  'judge.provider',
  'judge.model',
  'judge.endpoint',
  'judge.timeoutMs',
  'judge.credential.mode',
  'judge.credential.ref',
] as const

export interface BelayConfigOptions {
  targetDir?: string
  subcommand?: BelayConfigSubcommand
  path?: string
  value?: string
  json?: boolean
}

export interface BelayConfigCredentialOptions {
  targetDir?: string
  action: 'mode' | 'set' | 'clear'
  mode?: 'project' | 'apiKey'
  keyStdin?: boolean
  keyEnv?: string
}

export interface ConfigWizardAnswers {
  adapter: AdapterName
  scope: 'project' | 'global'
  withSkill: boolean
  judgeProviderId: JudgeProviderId
  judgeCredentialMode?: 'project' | 'apiKey'
  judgeEndpoint?: string
  acceptCloud: boolean
  dogfood: boolean
}

export function parseAdapter(value: string | undefined): AdapterName {
  const normalized = (value?.trim() || 'cursor').toLowerCase()
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'cursor') {
    return normalized
  }
  throw new Error(`Unknown adapter: ${value ?? '(empty)'}`)
}

export function parseScope(value: string | undefined): 'project' | 'global' {
  const normalized = (value?.trim() || 'project').toLowerCase()
  if (normalized === 'global' || normalized === 'project') {
    return normalized
  }
  throw new Error(`Unknown scope: ${value ?? '(empty)'}`)
}

export function parseYesNo(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = (value?.trim() || (defaultValue ? 'y' : 'n')).toLowerCase()
  if (['y', 'yes', 'true', '1'].includes(normalized)) {
    return true
  }
  if (['n', 'no', 'false', '0'].includes(normalized)) {
    return false
  }
  return defaultValue
}

export function parseJudgeProviderId(
  value: string | undefined,
  defaultId: JudgeProviderId | string,
): JudgeProviderId {
  const normalized = (value?.trim() || defaultId).toLowerCase()
  const canonical = normalizeLegacyProviderId(normalized)
  if (canonical) {
    return canonical
  }
  throw new Error(`Unknown judge provider: ${value ?? '(empty)'}`)
}

export function buildInitOptionsFromConfigAnswers(
  answers: ConfigWizardAnswers,
  targetDir?: string,
): InitOptions {
  return {
    targetDir,
    adapter: answers.adapter,
    scope: answers.scope,
    withSkill: answers.withSkill,
    judgeProviderId: answers.judgeProviderId,
    judgeEndpoint: answers.judgeEndpoint,
    judgeCredentialMode: answers.judgeCredentialMode,
    acceptCloudJudge: answers.acceptCloud,
    dogfood: answers.dogfood,
  }
}

function assertJudgeConfigPath(pathKey: string | undefined): string {
  if (!pathKey?.startsWith('judge.')) {
    throw new Error(`belay config only supports judge.* paths (got ${pathKey ?? '(empty)'}).`)
  }
  return pathKey
}

function getJudgeField(judge: BelayJudgeConfig, pathKey: string): unknown {
  if (pathKey === 'judge.providerId') return judge.providerId ?? null
  if (pathKey === 'judge.provider') return judge.provider
  if (pathKey === 'judge.model') return judge.model
  if (pathKey === 'judge.endpoint') return judge.endpoint ?? null
  if (pathKey === 'judge.timeoutMs') return judge.timeoutMs
  if (pathKey === 'judge.credential.mode') return judge.credential?.mode ?? null
  if (pathKey === 'judge.credential.ref') return judge.credential?.ref ?? null
  throw new Error(`Unknown judge config path: ${pathKey}`)
}

function listJudgeFields(judge: BelayJudgeConfig): Record<string, unknown> {
  const entries: Record<string, unknown> = {}
  for (const key of JUDGE_CONFIG_PATHS) {
    entries[key] = getJudgeField(judge, key)
  }
  return entries
}

function warnCloudConsentIfNeeded(judge: BelayJudgeConfig): void {
  if (
    isCloudJudgeConfig(judge) &&
    resolveJudgeTransport(judge) === 'http' &&
    !hasValidCloudConsent(judge)
  ) {
    process.stderr.write(
      'Warning: Cloud judge saved without recorded consent. Tier1 cloud judge will fail closed until consent is granted (belay judge consent + belay approve, or TTY --accept-cloud-judge).\n',
    )
  }
}

async function persistJudge(
  repoRoot: string,
  config: BelayConfigV4,
  judge: BelayJudgeConfig,
  adapter: ReturnType<typeof resolveAdapterName>,
): Promise<BelayConfigV4> {
  const updated: BelayConfigV4 = { ...config, judge: normalizeJudgeConfig(judge) }
  await writeConfigFile(repoRoot, updated, adapter)
  await refreshIntegrityIfPinned(repoRoot, updated)
  return updated
}

async function applyJudgeSet(
  repoRoot: string,
  config: BelayConfigV4,
  pathKey: string,
  rawValue: string,
): Promise<BelayJudgeConfig> {
  const adapter = resolveAdapterName(config)
  const value = rawValue.trim()

  if (pathKey === 'judge.providerId') {
    if (!isJudgeProviderId(value)) {
      throw new Error(`Unknown judge provider id: ${value}`)
    }
    const patch = resolveJudgeUsePatch(config.judge, { providerId: value })
    if (patch.errors.length > 0) {
      throw new Error(patch.errors.join(' '))
    }
    const updated = await persistJudge(repoRoot, config, patch.judge, adapter)
    warnCloudConsentIfNeeded(updated.judge)
    return updated.judge
  }

  if (pathKey === 'judge.model') {
    rejectDeprecatedJudgeModelAuto(value)
    const judge = normalizeJudgeConfig({ ...config.judge, model: value })
    await persistJudge(repoRoot, config, judge, adapter)
    return judge
  }

  if (pathKey === 'judge.endpoint') {
    const endpoint = value === 'null' || value === '' ? null : value
    const judge = normalizeJudgeConfig({ ...config.judge, endpoint })
    await persistJudge(repoRoot, config, judge, adapter)
    return judge
  }

  if (pathKey === 'judge.timeoutMs') {
    const timeoutMs = Number(value)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('judge.timeoutMs must be a positive number.')
    }
    const judge = normalizeJudgeConfig({ ...config.judge, timeoutMs })
    await persistJudge(repoRoot, config, judge, adapter)
    return judge
  }

  if (pathKey === 'judge.provider') {
    throw new Error('judge.provider is derived from providerId; use judge.providerId instead.')
  }

  if (pathKey === 'judge.credential.mode') {
    if (value !== 'project' && value !== 'apiKey') {
      throw new Error('judge.credential.mode must be project or apiKey.')
    }
    const judge = normalizeJudgeConfig({
      ...config.judge,
      credential:
        value === 'project' ? { mode: 'project' } : { mode: 'apiKey', ref: 'store:judge' },
    })
    await persistJudge(repoRoot, config, judge, adapter)
    return judge
  }

  if (pathKey === 'judge.credential.ref') {
    if (value !== 'store:judge' && !value.startsWith('env:')) {
      throw new Error('judge.credential.ref must be store:judge or env:NAME.')
    }
    const judge = normalizeJudgeConfig({
      ...config.judge,
      credential: { mode: 'apiKey', ref: value as JudgeCredentialRef },
    })
    await persistJudge(repoRoot, config, judge, adapter)
    return judge
  }

  throw new Error(`Unknown judge config path: ${pathKey}`)
}

async function applyJudgeUnset(
  repoRoot: string,
  config: BelayConfigV4,
  pathKey: string,
): Promise<BelayJudgeConfig> {
  const adapter = resolveAdapterName(config)

  if (pathKey === 'judge.endpoint') {
    const judge = normalizeJudgeConfig({ ...config.judge, endpoint: null })
    await persistJudge(repoRoot, config, judge, adapter)
    return judge
  }

  if (pathKey === 'judge.credential.ref') {
    const judge = normalizeJudgeConfig({
      ...config.judge,
      credential: config.judge.credential?.mode === 'apiKey' ? { mode: 'apiKey' } : undefined,
    })
    await persistJudge(repoRoot, config, judge, adapter)
    return judge
  }

  throw new Error(
    `Cannot unset ${pathKey}; only judge.endpoint and judge.credential.ref are unsettable.`,
  )
}

async function appendConfigAudit(
  repoRoot: string,
  config: BelayConfigV4,
  event: Record<string, unknown>,
): Promise<void> {
  const adapter = resolveAdapterName(config)
  const updated = await loadConfigFile(repoRoot, adapter)
  await appendCliAuditEvent(repoRoot, updated, event)
}

export async function runBelayConfigCredential(options: BelayConfigCredentialOptions) {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const adapter = resolveAdapterName(config)

  if (options.action === 'mode') {
    if (options.mode !== 'project' && options.mode !== 'apiKey') {
      throw new Error('credential mode requires project or apiKey.')
    }
    const judge =
      options.mode === 'project'
        ? normalizeJudgeConfig({ ...config.judge, credential: { mode: 'project' } })
        : normalizeJudgeConfig({
            ...config.judge,
            credential: options.keyEnv
              ? { mode: 'apiKey', ref: `env:${options.keyEnv}` }
              : { mode: 'apiKey', ref: 'store:judge' },
          })
    await persistJudge(repoRoot, config, judge, adapter)
    await appendConfigAudit(repoRoot, config, {
      event: 'judge_config_credential',
      action: 'mode',
      mode: options.mode,
      by: 'belay config credential mode',
    })
    return options.mode === 'project'
      ? 'Credential mode set to project.'
      : 'Credential mode set to apiKey.'
  }

  if (options.action === 'set') {
    let key: string | undefined
    if (options.keyStdin) {
      key = await readKeyFromStdin()
      if (!key) {
        throw new Error('--key-stdin requires a non-empty API key on stdin.')
      }
    }
    if (options.keyEnv) {
      const judge = normalizeJudgeConfig({
        ...config.judge,
        credential: { mode: 'apiKey', ref: `env:${options.keyEnv}` },
      })
      await persistJudge(repoRoot, config, judge, adapter)
      await appendConfigAudit(repoRoot, config, {
        event: 'judge_config_credential',
        action: 'set',
        ref: `env:${options.keyEnv}`,
        by: 'belay config credential set',
      })
      return `Credential ref set to env:${options.keyEnv}.`
    }
    if (!key) {
      throw new Error('credential set requires --key-stdin or --key-env.')
    }
    const stateDir = belayStateDir(config, repoLocalStateDirFor(repoRoot, config))
    await writeJudgeCredentialStore(stateDir, key)
    const judge = normalizeJudgeConfig({
      ...config.judge,
      credential: { mode: 'apiKey', ref: 'store:judge' },
    })
    await persistJudge(repoRoot, config, judge, adapter)
    await appendConfigAudit(repoRoot, config, {
      event: 'judge_config_credential',
      action: 'set',
      ref: 'store:judge',
      by: 'belay config credential set',
    })
    return 'API key stored in belay credential store.'
  }

  if (options.action === 'clear') {
    const stateDir = belayStateDir(config, repoLocalStateDirFor(repoRoot, config))
    await clearJudgeCredentialStore(stateDir)
    const judge = normalizeJudgeConfig({
      ...config.judge,
      credential: config.judge.credential?.mode === 'project' ? { mode: 'project' } : undefined,
    })
    await persistJudge(repoRoot, config, judge, adapter)
    await appendConfigAudit(repoRoot, config, {
      event: 'judge_config_credential',
      action: 'clear',
      by: 'belay config credential clear',
    })
    return 'Stored API key cleared.'
  }

  throw new Error('credential requires action: mode, set, or clear.')
}

export interface BelayConfigInteractiveOptions {
  targetDir?: string
  /** @internal test helper — canned readline answers in order */
  prompts?: string[]
  /** Suppress the interactive header when nested under runBelayConfigInteractive */
  skipBanner?: boolean
}

type ConfigPrompter = (message: string) => Promise<string>

interface CloudJudgeWizardAnswers {
  judgeCredentialMode?: 'project' | 'apiKey'
  judgeEndpoint?: string
  acceptCloud: boolean
}

async function collectCloudJudgeWizardAnswers(
  ask: ConfigPrompter,
  judgeProviderId: JudgeProviderId,
): Promise<CloudJudgeWizardAnswers> {
  if (judgeProviderId === 'ollama') {
    return { acceptCloud: false }
  }

  const judgeCredentialMode = parseYesNo(
    await ask('Use project env for credentials? [y=project | n=apiKey] (y): '),
    true,
  )
    ? 'project'
    : 'apiKey'

  const optionalEndpoint = (await ask('Judge endpoint URL (optional): ')).trim()
  const judgeEndpoint = optionalEndpoint || undefined

  if (judgeCredentialMode === 'apiKey') {
    const key = await ask('Paste API key (hidden input not available in all shells): ')
    if (key.trim()) {
      process.env.BELAY_CONFIG_WIZARD_JUDGE_KEY = key.trim()
    }
  }

  let acceptCloud = false
  if (judgeEndpoint) {
    acceptCloud = parseYesNo(
      await ask('Accept cloud judge egress (redacted commands leave the repo)? [y | n] (n): '),
      false,
    )
  }

  return { judgeCredentialMode, judgeEndpoint, acceptCloud }
}

async function withConfigPrompter<T>(
  fn: (ask: ConfigPrompter) => Promise<T>,
  prompts?: string[],
): Promise<T> {
  if (prompts) {
    let index = 0
    const ask: ConfigPrompter = async (message) => {
      if (index >= prompts.length) {
        throw new Error(`unexpected config prompt: ${message}`)
      }
      return prompts[index++]
    }
    return fn(ask)
  }

  const rl = readline.createInterface({ input, output })
  try {
    return await fn((message) => rl.question(message))
  } finally {
    rl.close()
  }
}

export async function resolveBelayConfigInteractiveMode(
  repoRoot: string,
): Promise<'full' | 'judge-only'> {
  try {
    return (await isBelayFloorInstalled({ targetDir: repoRoot })) ? 'judge-only' : 'full'
  } catch {
    return 'full'
  }
}

async function runBelayConfigFullWithPrompter(
  ask: ConfigPrompter,
  options: BelayConfigInteractiveOptions,
): Promise<{ repoRoot: string; withSkill: boolean; dogfood: boolean; adapter: AdapterName }> {
  if (!options.skipBanner) {
    output.write('belay config\n')
  }
  const adapter = parseAdapter(await ask('Adapter [cursor | claude | codex] (cursor): '))
  const scope = parseScope(await ask('Install scope [project | global] (project): '))
  const withSkill = parseYesNo(
    await ask('Install SKILL.md and slash commands? [y | n] (y): '),
    true,
  )
  const defaultJudgeProviderId = defaultJudgeProviderForAdapter(adapter)
  const judgeProviderId = parseJudgeProviderId(
    await ask(`Judge provider [${JUDGE_PROVIDER_IDS.join(' | ')}] (${defaultJudgeProviderId}): `),
    defaultJudgeProviderId,
  )

  const { judgeCredentialMode, judgeEndpoint, acceptCloud } = await collectCloudJudgeWizardAnswers(
    ask,
    judgeProviderId,
  )

  const initOptions = buildInitOptionsFromConfigAnswers(
    {
      adapter,
      scope,
      withSkill,
      judgeProviderId,
      judgeCredentialMode,
      judgeEndpoint,
      acceptCloud,
      dogfood: false,
    },
    options.targetDir,
  )

  const result = await initProject(initOptions)

  if (process.env.BELAY_CONFIG_WIZARD_JUDGE_KEY && judgeCredentialMode === 'apiKey') {
    const config = await loadConfigFile(result.repoRoot, result.adapter)
    const stateDir = belayStateDir(config, repoLocalStateDirFor(result.repoRoot, config))
    await writeJudgeCredentialStore(stateDir, process.env.BELAY_CONFIG_WIZARD_JUDGE_KEY)
    delete process.env.BELAY_CONFIG_WIZARD_JUDGE_KEY
  }

  return result
}

async function runBelayConfigJudgeOnlyWithPrompter(
  ask: ConfigPrompter,
  options: BelayConfigInteractiveOptions,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfigFile>>,
  adapter: AdapterName,
): Promise<{ repoRoot: string; adapter: AdapterName }> {
  if (!options.skipBanner) {
    output.write('belay config (judge only)\n')
  }
  const defaultJudgeProviderId = defaultJudgeProviderForAdapter(adapter)
  const judgeProviderId = parseJudgeProviderId(
    await ask(`Judge provider [${JUDGE_PROVIDER_IDS.join(' | ')}] (${defaultJudgeProviderId}): `),
    defaultJudgeProviderId,
  )

  const { judgeCredentialMode, judgeEndpoint, acceptCloud } = await collectCloudJudgeWizardAnswers(
    ask,
    judgeProviderId,
  )

  const patch = resolveJudgeUsePatch(config.judge, {
    providerId: judgeProviderId,
    endpoint: judgeEndpoint,
    credentialMode: judgeCredentialMode,
    acceptCloud: acceptCloud && Boolean(judgeEndpoint),
    interactiveTTY: true,
    interactiveConsentApproved: acceptCloud && Boolean(judgeEndpoint),
  })
  if (patch.errors.length > 0) {
    throw new Error(patch.errors.join(' '))
  }
  for (const warning of patch.warnings) {
    process.stderr.write(`Warning: ${warning}\n`)
  }

  const updated = await persistJudge(repoRoot, config, patch.judge, adapter)
  warnCloudConsentIfNeeded(updated.judge)

  if (process.env.BELAY_CONFIG_WIZARD_JUDGE_KEY && judgeCredentialMode === 'apiKey') {
    const stateDir = belayStateDir(updated, repoLocalStateDirFor(repoRoot, updated))
    await writeJudgeCredentialStore(stateDir, process.env.BELAY_CONFIG_WIZARD_JUDGE_KEY)
    delete process.env.BELAY_CONFIG_WIZARD_JUDGE_KEY
  }

  await appendConfigAudit(repoRoot, updated, {
    event: 'judge_config_interactive',
    providerId: updated.judge.providerId,
    credentialMode: updated.judge.credential?.mode ?? null,
    by: 'belay config interactive (judge only)',
  })

  return { repoRoot, adapter }
}

export async function runBelayConfigFullInteractive(
  options: BelayConfigInteractiveOptions = {},
): Promise<{ repoRoot: string; withSkill: boolean; dogfood: boolean; adapter: AdapterName }> {
  return withConfigPrompter((ask) => runBelayConfigFullWithPrompter(ask, options), options.prompts)
}

export async function runBelayConfigJudgeOnlyInteractive(
  options: BelayConfigInteractiveOptions = {},
): Promise<{ repoRoot: string; adapter: AdapterName }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const adapter = resolveAdapterName(config)

  return withConfigPrompter(
    (ask) => runBelayConfigJudgeOnlyWithPrompter(ask, options, repoRoot, config, adapter),
    options.prompts,
  )
}

export async function runBelayConfigInteractive(options: BelayConfigInteractiveOptions = {}) {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const mode = await resolveBelayConfigInteractiveMode(repoRoot)

  if (mode === 'judge-only') {
    if (options.prompts) {
      const judgeOnly = parseYesNo(options.prompts[0] ?? '', true)
      const remainingPrompts = options.prompts.slice(1)
      if (judgeOnly) {
        return runBelayConfigJudgeOnlyInteractive({
          ...options,
          prompts: remainingPrompts,
          skipBanner: true,
        })
      }
      return runBelayConfigFullInteractive({
        ...options,
        prompts: remainingPrompts,
        skipBanner: true,
      })
    }

    return withConfigPrompter(async (ask) => {
      output.write('belay config\n')
      const judgeOnly = parseYesNo(await ask('Configure judge only? [Y/n]: '), true)
      if (judgeOnly) {
        const config = await loadConfigFile(repoRoot)
        const adapter = resolveAdapterName(config)
        return runBelayConfigJudgeOnlyWithPrompter(
          ask,
          { ...options, skipBanner: true },
          repoRoot,
          config,
          adapter,
        )
      }
      return runBelayConfigFullWithPrompter(ask, { ...options, skipBanner: true })
    }, options.prompts)
  }

  return runBelayConfigFullInteractive(options)
}

export async function runBelayConfig(options: BelayConfigOptions = {}) {
  if (!options.subcommand) {
    return runBelayConfigInteractive({ targetDir: options.targetDir })
  }

  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)

  if (options.subcommand === 'list') {
    const entries = listJudgeFields(config.judge)
    if (options.json) {
      return entries
    }
    return Object.entries(entries)
      .map(([key, value]) => `${key}: ${value === null ? '(null)' : String(value)}`)
      .join('\n')
  }

  if (options.subcommand === 'get') {
    const pathKey = assertJudgeConfigPath(options.path)
    const value = getJudgeField(config.judge, pathKey)
    if (options.json) {
      return { path: pathKey, value }
    }
    return value === null ? '(null)' : String(value)
  }

  if (options.subcommand === 'set') {
    const pathKey = assertJudgeConfigPath(options.path)
    if (options.value === undefined) {
      throw new Error('belay config set requires <path> <value>.')
    }
    await applyJudgeSet(repoRoot, config, pathKey, options.value)
    await appendConfigAudit(repoRoot, config, {
      event: 'judge_config_set',
      path: pathKey,
      value: options.value,
      by: 'belay config set',
    })
    return `Set ${pathKey} = ${options.value}`
  }

  if (options.subcommand === 'unset') {
    const pathKey = assertJudgeConfigPath(options.path)
    await applyJudgeUnset(repoRoot, config, pathKey)
    await appendConfigAudit(repoRoot, config, {
      event: 'judge_config_unset',
      path: pathKey,
      by: 'belay config unset',
    })
    return `Unset ${pathKey}`
  }

  if (options.subcommand === 'judge') {
    return judgeStatus({ targetDir: repoRoot, json: options.json })
  }

  throw new Error(`Unknown config subcommand: ${options.subcommand}`)
}
