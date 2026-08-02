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
  getJudgeProviderSpec,
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
import { confirmPrompt, intro, isInteractiveTTY, type SelectOptions, selectPrompt } from './tui.js'

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

interface ConfigWizardPrompter {
  askText(message: string): Promise<string>
  askSelect<T extends string>(
    options: SelectOptions<T>,
    parseRaw?: (raw: string, options: SelectOptions<T>) => T,
  ): Promise<T>
  askConfirm(message: string, defaultValue: boolean): Promise<boolean>
}

interface CloudJudgeWizardAnswers {
  judgeCredentialMode?: 'project' | 'apiKey'
  judgeEndpoint?: string
  acceptCloud: boolean
}

export const JUDGE_CREDENTIAL_MODE_PROMPT = 'Judge API key source'

export const JUDGE_CREDENTIAL_STORE_KEY_PROMPT =
  'Paste API key to store locally (visible input; prefer belay config credential set --key-stdin): '

export function buildJudgeCredentialModeSelectOptions(
  judgeProviderId: JudgeProviderId,
): SelectOptions<'project' | 'apiKey'> {
  const spec = getJudgeProviderSpec(judgeProviderId)
  const providerEnvVars =
    spec?.apiKeyEnvVars.filter((name) => name !== 'BELAY_JUDGE_API_KEY') ?? []
  const envNames =
    providerEnvVars.length > 0
      ? ['BELAY_JUDGE_API_KEY', ...providerEnvVars].join(', ')
      : 'BELAY_JUDGE_API_KEY'
  const projectHint =
    providerEnvVars.length > 0
      ? `Uses ${envNames} from the shell; does not read .env files. Or host CLI login when available.`
      : 'Uses BELAY_JUDGE_API_KEY from the shell; does not read .env files.'

  return {
    message: JUDGE_CREDENTIAL_MODE_PROMPT,
    defaultValue: 'project',
    choices: [
      {
        value: 'project',
        label: 'Environment variables or host CLI',
        hint: projectHint,
      },
      {
        value: 'apiKey',
        label: 'Store in Belay credential store',
        hint: 'Saved to credentials.json (mode 0600) on the next step.',
      },
    ],
  }
}

function formatSelectPrompt<T extends string>(options: SelectOptions<T>): string {
  const hasDetails = options.choices.some((choice) => choice.hint || choice.label)
  if (hasDetails) {
    const lines = options.choices.map((choice) => {
      const label = choice.label ?? choice.value
      const hint = choice.hint ? ` — ${choice.hint}` : ''
      return `  ${choice.value}: ${label}${hint}`
    })
    const values = options.choices.map((choice) => choice.value).join(' | ')
    return `${options.message}\n${lines.join('\n')}\n[${values}] (${options.defaultValue}): `
  }
  const values = options.choices.map((choice) => choice.value).join(' | ')
  return `${options.message} [${values}] (${options.defaultValue}): `
}

function formatConfirmPrompt(message: string, defaultValue: boolean): string {
  return `${message} [y | n] (${defaultValue ? 'y' : 'n'}): `
}

function parseSelectAnswer<T extends string>(raw: string, options: SelectOptions<T>): T {
  const normalized = raw.trim().toLowerCase()
  if (!normalized) {
    return options.defaultValue
  }
  const found = options.choices.find((choice) => {
    if (choice.value.toLowerCase() === normalized) {
      return true
    }
    return choice.label?.trim().toLowerCase() === normalized
  })
  if (!found) {
    throw new Error(`Invalid choice for ${options.message}: ${raw}`)
  }
  return found.value
}

async function askTextLazy(message: string): Promise<string> {
  const rl = readline.createInterface({ input, output })
  try {
    return (await rl.question(message)).trimEnd()
  } finally {
    rl.close()
  }
}

function createTestPrompter(prompts: string[]): ConfigWizardPrompter {
  let index = 0
  const nextPrompt = (message: string) => {
    if (index >= prompts.length) {
      throw new Error(`unexpected config prompt: ${message}`)
    }
    return prompts[index++]
  }
  return {
    askText: async (message) => nextPrompt(message),
    askSelect: async (options, parseRaw) => {
      const raw = nextPrompt(formatSelectPrompt(options))
      return parseRaw ? parseRaw(raw, options) : parseSelectAnswer(raw, options)
    },
    askConfirm: async (message, defaultValue) =>
      parseYesNo(nextPrompt(formatConfirmPrompt(message, defaultValue)), defaultValue),
  }
}

function createReadlinePrompter(): ConfigWizardPrompter {
  return {
    askText: askTextLazy,
    askSelect: async (options, parseRaw) => {
      const raw = await askTextLazy(formatSelectPrompt(options))
      return parseRaw ? parseRaw(raw, options) : parseSelectAnswer(raw, options)
    },
    askConfirm: async (message, defaultValue) =>
      parseYesNo(await askTextLazy(formatConfirmPrompt(message, defaultValue)), defaultValue),
  }
}

function createTuiPrompter(): ConfigWizardPrompter {
  return {
    askText: askTextLazy,
    askSelect: selectPrompt,
    askConfirm: confirmPrompt,
  }
}

async function withConfigWizardPrompter<T>(
  options: BelayConfigInteractiveOptions,
  fn: (prompter: ConfigWizardPrompter) => Promise<T>,
): Promise<T> {
  if (options.prompts) {
    return fn(createTestPrompter(options.prompts))
  }
  if (isInteractiveTTY()) {
    return fn(createTuiPrompter())
  }
  return fn(createReadlinePrompter())
}

function writeConfigWizardBanner(options: BelayConfigInteractiveOptions, title: string): void {
  if (options.skipBanner) {
    return
  }
  if (isInteractiveTTY()) {
    intro(title)
    return
  }
  output.write(`${title}\n`)
}

async function askJudgeCredentialStoreKey(prompter: ConfigWizardPrompter): Promise<string> {
  while (true) {
    const key = (await prompter.askText(JUDGE_CREDENTIAL_STORE_KEY_PROMPT)).trim()
    if (key) {
      return key
    }
    process.stderr.write(
      'Warning: API key cannot be empty. Paste a key or re-run belay config and choose environment variables.\n',
    )
  }
}

async function collectCloudJudgeWizardAnswers(
  prompter: ConfigWizardPrompter,
  judgeProviderId: JudgeProviderId,
): Promise<CloudJudgeWizardAnswers> {
  if (judgeProviderId === 'ollama') {
    return { acceptCloud: false }
  }

  const judgeCredentialMode = await prompter.askSelect<'project' | 'apiKey'>(
    buildJudgeCredentialModeSelectOptions(judgeProviderId),
  )

  const optionalEndpoint = (await prompter.askText('Judge endpoint URL (optional): ')).trim()
  const judgeEndpoint = optionalEndpoint || undefined

  if (judgeCredentialMode === 'apiKey') {
    process.env.BELAY_CONFIG_WIZARD_JUDGE_KEY = await askJudgeCredentialStoreKey(prompter)
  }

  let acceptCloud = false
  if (judgeEndpoint) {
    acceptCloud = await prompter.askConfirm(
      'Accept cloud judge egress (redacted commands leave the repo)?',
      false,
    )
  }

  return { judgeCredentialMode, judgeEndpoint, acceptCloud }
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

async function runBelayConfigFullWithWizard(
  prompter: ConfigWizardPrompter,
  options: BelayConfigInteractiveOptions,
): Promise<{ repoRoot: string; withSkill: boolean; dogfood: boolean; adapter: AdapterName }> {
  writeConfigWizardBanner(options, 'belay config')

  const adapter = await prompter.askSelect<AdapterName>({
    message: 'Adapter',
    defaultValue: 'cursor',
    choices: [{ value: 'cursor' }, { value: 'claude' }, { value: 'codex' }],
  })
  const scope = await prompter.askSelect<'project' | 'global'>({
    message: 'Install scope',
    defaultValue: 'project',
    choices: [{ value: 'project' }, { value: 'global' }],
  })
  const withSkill = await prompter.askConfirm('Install SKILL.md and slash commands?', true)

  const defaultJudgeProviderId = defaultJudgeProviderForAdapter(adapter)
  const judgeProviderId = await prompter.askSelect<JudgeProviderId>(
    {
      message: 'Judge provider',
      defaultValue: defaultJudgeProviderId,
      choices: JUDGE_PROVIDER_IDS.map((providerId) => ({ value: providerId })),
    },
    (raw, selectOptions) => parseJudgeProviderId(raw, selectOptions.defaultValue),
  )

  const { judgeCredentialMode, judgeEndpoint, acceptCloud } = await collectCloudJudgeWizardAnswers(
    prompter,
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

async function runBelayConfigJudgeOnlyWithWizard(
  prompter: ConfigWizardPrompter,
  options: BelayConfigInteractiveOptions,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfigFile>>,
  adapter: AdapterName,
): Promise<{ repoRoot: string; adapter: AdapterName }> {
  writeConfigWizardBanner(options, 'belay config (judge only)')

  const defaultJudgeProviderId = defaultJudgeProviderForAdapter(adapter)
  const judgeProviderId = await prompter.askSelect<JudgeProviderId>(
    {
      message: 'Judge provider',
      defaultValue: defaultJudgeProviderId,
      choices: JUDGE_PROVIDER_IDS.map((providerId) => ({ value: providerId })),
    },
    (raw, selectOptions) => parseJudgeProviderId(raw, selectOptions.defaultValue),
  )

  const { judgeCredentialMode, judgeEndpoint, acceptCloud } = await collectCloudJudgeWizardAnswers(
    prompter,
    judgeProviderId,
  )

  const patch = resolveJudgeUsePatch(config.judge, {
    providerId: judgeProviderId,
    endpoint: judgeEndpoint,
    credentialMode: judgeCredentialMode,
    acceptCloud: acceptCloud && Boolean(judgeEndpoint),
    // `prompts` is a scripted stand-in for interactive responses in tests.
    interactiveTTY: isInteractiveTTY() || Boolean(options.prompts),
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
  return withConfigWizardPrompter(options, (prompter) =>
    runBelayConfigFullWithWizard(prompter, options),
  )
}

export async function runBelayConfigJudgeOnlyInteractive(
  options: BelayConfigInteractiveOptions = {},
): Promise<{ repoRoot: string; adapter: AdapterName }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const adapter = resolveAdapterName(config)

  return withConfigWizardPrompter(options, (prompter) =>
    runBelayConfigJudgeOnlyWithWizard(prompter, options, repoRoot, config, adapter),
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

    return withConfigWizardPrompter(options, async (prompter) => {
      writeConfigWizardBanner(options, 'belay config')
      const judgeOnly = await prompter.askConfirm('Configure judge only?', true)
      if (!judgeOnly) {
        return runBelayConfigFullWithWizard(prompter, { ...options, skipBanner: true })
      }
      const config = await loadConfigFile(repoRoot)
      const adapter = resolveAdapterName(config)
      return runBelayConfigJudgeOnlyWithWizard(
        prompter,
        { ...options, skipBanner: true },
        repoRoot,
        config,
        adapter,
      )
    })
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
