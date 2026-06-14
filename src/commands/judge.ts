import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import path from 'node:path'

import { getAdapterLayout } from '../adapters/layouts/index.js'
import { resolveScopedPaths } from '../adapters/layouts/scope.js'
import {
  configPathFor,
  loadApprovalState,
  loadConfigFile,
  repoLocalStateDirFor,
  resolveAdapterName,
  writeConfigFile,
} from '../config-io.js'
import { appendCliAuditEvent } from '../core/audit-io.js'
import { JUDGE_CLOUD_CONSENT_REASON } from '../core/capability/reasons.js'
import type { BelayConfigV4, BelayJudgeConfig } from '../core/config.js'
import { belayStateDir, normalizeJudgeConfig } from '../core/config.js'
import { writeJudgeCredentialStore } from '../core/credential-store.js'
import { runtimeIntegrityFiles, writeIntegrityManifest } from '../core/integrity.js'
import { resolveJudgeCredential } from '../core/judge-api-key.js'
import {
  hasValidCloudConsent,
  isCloudJudgeConfig,
  resolveJudgeUsePatch,
} from '../core/judge-config.js'
import { ensurePendingJudgeCloudConsentApproval } from '../core/judge-cloud-consent.js'
import { diagnoseJudge } from '../core/judge-doctor.js'
import { resolveJudgeModel } from '../core/verdict/judge-factory.js'
import {
  JUDGE_CATALOG,
  JUDGE_PROVIDER_IDS,
  getJudgeProviderSpec,
  isJudgeProviderId,
} from '../core/verdict/judge-catalog.js'

export interface JudgeCommandOptions {
  targetDir?: string
  json?: boolean
  subcommand?: 'status' | 'list' | 'use' | 'test' | 'consent'
  providerId?: string
  model?: string
  endpoint?: string
  timeoutMs?: number
  acceptCloud?: boolean
  cloudConsentApprovalId?: string
  credentialMode?: 'project' | 'apiKey'
  keyStdin?: boolean
  keyEnv?: string
}

export function isInteractiveTTY(): boolean {
  return Boolean(input.isTTY && output.isTTY)
}

async function readKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function confirmCloudConsent(endpoint: string): Promise<boolean> {
  if (!isInteractiveTTY()) {
    return false
  }
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(
      `Cloud judge sends redacted commands to ${endpoint}. Continue? [y/N] `,
    )
    return ['y', 'yes'].includes(answer.trim().toLowerCase())
  } finally {
    rl.close()
  }
}

async function hasApprovedCloudConsent(
  repoRoot: string,
  config: BelayConfigV4,
  approvalId: string,
): Promise<boolean> {
  const approved = await loadApprovalState(repoRoot, 'approved-approvals.json', config)
  return approved.approvals.some(
    (entry) => entry.approvalId === approvalId && entry.reason === 'judge_cloud_consent',
  )
}

function formatJudgeDiff(before: BelayJudgeConfig, after: BelayJudgeConfig): string {
  const lines = ['Judge config changes:']
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<
    keyof BelayJudgeConfig
  >
  for (const key of keys) {
    const left = JSON.stringify(before[key])
    const right = JSON.stringify(after[key])
    if (left !== right) {
      lines.push(`  ${String(key)}: ${left} -> ${right}`)
    }
  }
  return lines.join('\n')
}

async function refreshIntegrityIfPinned(repoRoot: string, config: BelayConfigV4): Promise<void> {
  if (config.controlPlane.integrity !== 'hash-pinned') {
    return
  }
  const adapter = resolveAdapterName(config)
  const layout = getAdapterLayout(adapter)
  const installScope = config.installScope === 'global' ? 'global' : 'project'
  const scoped = resolveScopedPaths(layout, installScope, repoRoot)
  await writeIntegrityManifest(repoRoot, layout, runtimeIntegrityFiles(layout, scoped))
}

export async function judgeStatus(options: JudgeCommandOptions = {}) {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const judge = config.judge
  const spec = judge.providerId ? getJudgeProviderSpec(judge.providerId) : null
  const repoLocalDir = repoLocalStateDirFor(repoRoot, config)
  const credential = await resolveJudgeCredential({
    judge,
    catalogSpec: spec ?? undefined,
    repoRoot,
    repoLocalStateDir: repoLocalDir,
    config,
  })
  const { resolved } = resolveJudgeModel(judge)

  const lines = [
    `Judge providerId : ${judge.providerId ?? '(inferred)'}`,
    `Judge driver     : ${judge.provider}`,
    `Endpoint         : ${judge.endpoint ?? '(none)'}`,
    `Model            : ${resolved} (requested: ${judge.model})`,
    `Credential       : ${credential.mode}${credential.source ? ` → ${credential.source}` : ''} ${credential.key ? '✓ set' : '✗ missing'}`,
    `Cloud consent    : ${
      judge.cloudConsent?.accepted
        ? `accepted ${judge.cloudConsent.at} by ${judge.cloudConsent.by}`
        : 'not recorded'
    }`,
    `Tier1 fallback   : ask (fail-closed) — judge unreachable would block, not allow`,
  ]

  if (options.json) {
    return {
      providerId: judge.providerId,
      provider: judge.provider,
      endpoint: judge.endpoint,
      model: judge.model,
      modelResolved: resolved,
      credential,
      cloudConsent: judge.cloudConsent ?? null,
      cloudJudgeActive: isCloudJudgeConfig(judge) && hasValidCloudConsent(judge),
    }
  }
  return lines.join('\n')
}

export function judgeList(options: JudgeCommandOptions = {}) {
  const entries = JUDGE_PROVIDER_IDS.map((id) => {
    const spec = JUDGE_CATALOG[id]
    return {
      id,
      driver: spec.driver,
      cloud: spec.isCloud,
      defaultEndpoint: spec.defaultEndpoint,
      defaultModel: spec.defaultModel,
      apiKeyEnvVars: spec.apiKeyEnvVars,
    }
  })
  if (options.json) {
    return entries
  }
  return entries
    .map(
      (entry) =>
        `${entry.id} (${entry.cloud ? 'cloud' : 'local'}) driver=${entry.driver} model=${entry.defaultModel} endpoint=${entry.defaultEndpoint ?? 'required'}`,
    )
    .join('\n')
}

export async function judgeUse(options: JudgeCommandOptions) {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const adapter = resolveAdapterName(config)
  const providerId = options.providerId?.trim()
  if (!providerId || !isJudgeProviderId(providerId)) {
    throw new Error(`judge use requires provider-id: ${JUDGE_PROVIDER_IDS.join(', ')}`)
  }

  const before = { ...config.judge }

  if (
    options.keyStdin &&
    options.credentialMode === 'apiKey' &&
    options.acceptCloud &&
    isInteractiveTTY()
  ) {
    throw new Error(
      'Cannot combine --accept-cloud with --key-stdin in interactive mode. Use env for the API key, or record consent separately.',
    )
  }

  let keyFromStdin: string | undefined
  if (options.keyStdin && options.credentialMode === 'apiKey') {
    keyFromStdin = await readKeyFromStdin()
    if (!keyFromStdin) {
      throw new Error('--key-stdin requires a non-empty API key on stdin.')
    }
  }

  let interactiveConsentApproved = false
  if (options.acceptCloud && isInteractiveTTY()) {
    const spec = getJudgeProviderSpec(providerId)
    const endpoint =
      options.endpoint?.trim() || spec?.defaultEndpoint || before.endpoint?.trim() || ''
    if (endpoint) {
      interactiveConsentApproved = await confirmCloudConsent(endpoint)
    }
  }

  const cloudConsentApprovalId = options.cloudConsentApprovalId
  if (options.cloudConsentApprovalId) {
    const ok = await hasApprovedCloudConsent(repoRoot, config, options.cloudConsentApprovalId)
    if (!ok) {
      throw new Error(
        `Approval ${options.cloudConsentApprovalId} is not an approved judge_cloud_consent.`,
      )
    }
  } else if (options.acceptCloud && !isInteractiveTTY() && getJudgeProviderSpec(providerId)?.isCloud) {
    throw new Error(
      '--accept-cloud has no effect in non-interactive mode. Use TTY confirmation or --cloud-consent-approval-id.',
    )
  }

  const patch = resolveJudgeUsePatch(before, {
    providerId,
    model: options.model,
    endpoint: options.endpoint,
    timeoutMs: options.timeoutMs,
    acceptCloud: options.acceptCloud,
    cloudConsentApprovalId,
    credentialMode: options.credentialMode,
    keyEnv: options.keyEnv,
    interactiveTTY: isInteractiveTTY(),
    interactiveConsentApproved,
  })

  if (patch.errors.length > 0) {
    throw new Error(patch.errors.join(' '))
  }

  if (keyFromStdin !== undefined) {
    const stateDir = belayStateDir(config, repoLocalStateDirFor(repoRoot, config))
    await writeJudgeCredentialStore(stateDir, keyFromStdin)
  }

  const after = normalizeJudgeConfig(patch.judge)
  const updated: BelayConfigV4 = { ...config, judge: after }

  await writeConfigFile(repoRoot, updated, adapter)
  await refreshIntegrityIfPinned(repoRoot, updated)

  await appendCliAuditEvent(repoRoot, updated, {
    event: 'judge_provider_changed',
    from: { providerId: before.providerId, provider: before.provider },
    to: { providerId: after.providerId, provider: after.provider },
    by: 'belay judge use',
  })

  if (after.cloudConsent?.accepted && !before.cloudConsent?.accepted) {
    await appendCliAuditEvent(repoRoot, updated, {
      event: 'judge_cloud_consent_recorded',
      providerId: after.cloudConsent.providerId,
      endpoint: after.cloudConsent.endpoint,
      by: after.cloudConsent.by,
    })
  }

  const spec = getJudgeProviderSpec(providerId)
  const credential = await resolveJudgeCredential({
    judge: after,
    catalogSpec: spec ?? undefined,
    repoRoot,
    repoLocalStateDir: repoLocalStateDirFor(repoRoot, updated),
    config: updated,
  })
  if (spec?.isCloud && !credential.key) {
    patch.warnings.push(
      `API key not found for ${providerId}. Tier1 cloud judge will fail closed to ask.`,
    )
  }

  const result = {
    ok: true,
    configPath: configPathFor(repoRoot, adapter),
    diff: formatJudgeDiff(before, after),
    warnings: patch.warnings,
    judge: after,
  }

  if (options.json) {
    return result
  }

  const parts = [result.diff, ...result.warnings.map((w) => `Warning: ${w}`), 'Judge config updated.']
  return parts.join('\n')
}

export async function judgeRequestCloudConsent(options: JudgeCommandOptions = {}) {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const providerId = options.providerId?.trim()
  if (!providerId || !isJudgeProviderId(providerId)) {
    throw new Error(`judge consent requires --provider-id: ${JUDGE_PROVIDER_IDS.join(', ')}`)
  }
  const spec = getJudgeProviderSpec(providerId)
  if (!spec?.isCloud) {
    throw new Error(`judge consent applies only to cloud providers (${JUDGE_PROVIDER_IDS.filter((id) => JUDGE_CATALOG[id].isCloud).join(', ')}).`)
  }
  const endpoint =
    options.endpoint?.trim() ||
    config.judge.endpoint?.trim() ||
    spec.defaultEndpoint ||
    ''
  if (!endpoint) {
    throw new Error(`${providerId} requires --endpoint for cloud consent request.`)
  }

  const { approvalId, created } = await ensurePendingJudgeCloudConsentApproval({
    repoRoot,
    config,
    providerId,
    endpoint,
  })
  const lines = [
    `Cloud consent approval ${created ? 'created' : 'reused'}: ${approvalId}`,
    `Approve: belay approve ${approvalId}`,
    `Then: belay judge use ${providerId} --endpoint ${endpoint} --cloud-consent-approval-id ${approvalId}`,
  ]
  if (options.json) {
    return { approvalId, created, providerId, endpoint, reason: JUDGE_CLOUD_CONSENT_REASON }
  }
  return lines.join('\n')
}

export async function judgeTest(options: JudgeCommandOptions = {}) {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const diagnosis = await diagnoseJudge(config, repoRoot)
  if (options.json) {
    return diagnosis
  }
  return [
    ...diagnosis.notes.map((n) => `Note: ${n}`),
    ...diagnosis.warnings.map((w) => `Warning: ${w}`),
    ...diagnosis.issues.map((i) => `Issue: ${i}`),
  ].join('\n')
}

export async function runJudgeCommand(options: JudgeCommandOptions) {
  switch (options.subcommand) {
    case 'status':
      return judgeStatus(options)
    case 'list':
      return judgeList(options)
    case 'use':
      return judgeUse(options)
    case 'test':
      return judgeTest(options)
    case 'consent':
      return judgeRequestCloudConsent(options)
    default:
      throw new Error('judge requires subcommand: status, list, use, test, or consent')
  }
}
