import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { recordApproval } from '../../core/approval-service.js'
import { issueApprovalToken } from '../../core/approval-token.js'
import {
  fsScopeAllowlistPath,
  isCapabilityBrokerDemotionActive,
  loadFsScopeAllowlistSync,
  shouldSkipBrokerApprovedOnce,
  shouldSkipBrokerApprovedRecord,
} from '../../core/capability/index.js'
import { resolveLayeredConfig, teamConfigPath } from '../../core/config-layers.js'
import type { GatedAction, GatedActionKind } from '../../core/gate-contract.js'
import {
  classifyResultToGateVerdict,
  type GatePermissionResponse,
  type GateVerdict,
  unnormalizedGateVerdict,
} from '../../core/gate-contract.js'
import {
  classifyGatedActionAsync,
  extractAgentAssessment,
  GateNormalizationError,
  gateEnabledForAction,
  normalizeGatedAction,
} from '../../core/gate-engine.js'
import {
  APPROVAL_EXECUTION_LEASE_MS,
  type ApprovalStateFile,
  approvalCommandMatch,
  approvedApprovalsFile,
  type BelayConfigV3,
  buildRetryInstruction,
  type ClassifyResult,
  canonicalStringify,
  classifierOptionsFromConfig,
  compactApprovals,
  configuredControlPlaneDir,
  createApprovalRecord,
  pendingApprovalsFile,
  resolveControlPlaneDir,
  scrubOptionsFromConfig,
  scrubValue,
  toolFingerprint,
} from '../../core/index.js'
import { notifyDeny } from '../../core/notify.js'
import {
  isTransactionalEligible,
  runTransactionalExecution,
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPROVAL_BYPASS_REASONS,
} from '../../core/transactional/index.js'
import type { Assessment, ClassifierOptions } from '../../core/types.js'
import { protectedArtifactRoots } from '../layouts/protected-paths.js'
import type { AdapterLayout } from '../layouts/types.js'

const EMPTY_APPROVALS: ApprovalStateFile = {
  version: 1,
  approvals: [],
}

export interface GateRuntimeContext {
  layout: AdapterLayout
  repoRoot: string
  config: BelayConfigV3
  configPath: string
}

export interface GateRuntimeDeps {
  readConfig: (configPath: string) => Promise<unknown>
  appendAudit: (ctx: GateRuntimeContext, event: Record<string, unknown>) => Promise<void>
  loadApprovals: (
    ctx: GateRuntimeContext,
    fileName: 'pending-approvals.json' | 'approved-approvals.json',
  ) => Promise<{ filePath: string; state: ApprovalStateFile }>
  writeApprovals: (filePath: string, state: ApprovalStateFile) => Promise<void>
}

async function loadJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function createDefaultGateRuntimeDeps(): GateRuntimeDeps {
  return {
    async readConfig(configPath) {
      return loadJsonFile<Record<string, unknown>>(configPath, {})
    },
    async appendAudit(ctx, event) {
      const auditPath = path.join(ctx.repoRoot, ctx.config.audit.logPath)
      await mkdir(path.dirname(auditPath), { recursive: true })
      const record: Record<string, unknown> = { timestamp: new Date().toISOString(), ...event }
      if (!ctx.config.audit.includeAssessment) {
        delete record.assessment
      }
      const scrubbed = scrubValue(record, scrubOptionsFromConfig(ctx.config)) as Record<
        string,
        unknown
      >
      await writeFile(auditPath, `${JSON.stringify(scrubbed)}\n`, {
        encoding: 'utf8',
        flag: 'a',
      })
    },
    async loadApprovals(ctx, fileName) {
      const repoLocalStateDir = ctx.layout.repoLocalStateDir(ctx.repoRoot)
      const filePath =
        fileName === 'pending-approvals.json'
          ? pendingApprovalsFile(ctx.config, repoLocalStateDir)
          : approvedApprovalsFile(ctx.config, repoLocalStateDir)
      const loaded = await loadJsonFile<ApprovalStateFile>(filePath, EMPTY_APPROVALS)
      return {
        filePath,
        state: {
          version: loaded.version === 2 ? 2 : 1,
          approvals: Array.isArray(loaded.approvals) ? loaded.approvals : [],
        },
      }
    },
    async writeApprovals(filePath, state) {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8')
    },
  }
}

export async function resolveGateConfig(
  ctx: Pick<GateRuntimeContext, 'layout' | 'repoRoot' | 'configPath'>,
  deps: GateRuntimeDeps,
): Promise<BelayConfigV3> {
  const loaded = await deps.readConfig(ctx.configPath)
  let teamConfig: Record<string, unknown> | null = null
  const teamPath = teamConfigPath()
  if (existsSync(teamPath)) {
    teamConfig = JSON.parse(await readFile(teamPath, 'utf8')) as Record<string, unknown>
  }
  return resolveLayeredConfig({
    repoConfig: loaded,
    adapterDefaults: ctx.layout.defaultConfig(ctx.repoRoot) as BelayConfigV3,
    teamConfig,
    teamConfigPath: teamPath,
    repoConfigPath: ctx.configPath,
  }).config
}

export function repoShellClassifierOptions(
  config: BelayConfigV3,
  repoRoot: string,
  layout: AdapterLayout,
  extras: ClassifierOptions = {},
): ClassifierOptions {
  const controlPlaneDir = config.controlPlane.enabled ? resolveControlPlaneDir(config) : null
  return {
    ...classifierOptionsFromConfig(config),
    controlPlaneDir,
    protectedArtifactRoots: protectedArtifactRoots(layout, repoRoot, controlPlaneDir),
    ...extras,
  }
}

export function runtimeClassifierOptions(ctx: GateRuntimeContext, config: BelayConfigV3) {
  const repoLocalStateDir = ctx.layout.repoLocalStateDir(ctx.repoRoot)
  const brokerFsScope = isCapabilityBrokerDemotionActive(config)
  return repoShellClassifierOptions(config, ctx.repoRoot, ctx.layout, {
    brokerFsScope,
    fsScopeAllowlist: brokerFsScope
      ? loadFsScopeAllowlistSync(fsScopeAllowlistPath(config, repoLocalStateDir))
      : undefined,
  })
}

function gateAuditEventName(kind: GatedActionKind): string {
  if (kind === 'shell') {
    return 'beforeShellExecution'
  }
  if (kind === 'tool') {
    return 'preToolUse'
  }
  return 'subagentGate'
}

async function ensurePendingApproval(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  kind: GatedActionKind,
  result: ClassifyResult,
  approvalInput?: { input: string; inputKind: 'shell' | 'tool' | 'subagent' },
) {
  const pending = await deps.loadApprovals(ctx, 'pending-approvals.json')
  pending.state = compactApprovals(pending.state)
  const existing = pending.state.approvals.find(
    (approval) =>
      approval.kind === kind &&
      approval.fingerprint === result.fingerprint &&
      approval.repoRoot === ctx.repoRoot,
  )
  if (existing) {
    await deps.writeApprovals(pending.filePath, pending.state)
    return existing
  }

  const approval = createApprovalRecord({
    kind,
    fingerprint: result.fingerprint,
    repoRoot: ctx.repoRoot,
    reason: result.reason,
    summary: result.normalizedCommand ?? result.summary ?? '',
    approvalTtlMinutes: ctx.config.approvalTtlMinutes,
    approvalId: `belay_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    input: approvalInput?.input,
    inputKind: approvalInput?.inputKind,
  })
  pending.state.version = 2
  pending.state.approvals.push(approval)
  await deps.writeApprovals(pending.filePath, pending.state)
  return approval
}

async function consumeApprovedApproval(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  kind: GatedActionKind,
  fingerprint: string,
) {
  const approved = await deps.loadApprovals(ctx, 'approved-approvals.json')
  approved.state = compactApprovals(approved.state)
  const index = approved.state.approvals.findIndex(
    (approval) =>
      approval.kind === kind &&
      approval.fingerprint === fingerprint &&
      approval.repoRoot === ctx.repoRoot,
  )
  if (index === -1) {
    await deps.writeApprovals(approved.filePath, approved.state)
    return null
  }

  const approval = approved.state.approvals[index]
  if (approval.executionLeaseExpiresAt) {
    await deps.writeApprovals(approved.filePath, approved.state)
    return approval
  }

  approved.state.approvals[index] = {
    ...approval,
    executionLeaseExpiresAt: new Date(Date.now() + APPROVAL_EXECUTION_LEASE_MS).toISOString(),
  }
  await deps.writeApprovals(approved.filePath, approved.state)
  return approval
}

export async function evaluateGatedAction(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  params: {
    kind: GatedActionKind
    cwd: string
    command?: string
    payload?: Record<string, unknown>
    toolName?: string
  },
): Promise<GateVerdict> {
  let action: GatedAction
  try {
    action = normalizeGatedAction({
      kind: params.kind,
      repoRoot: ctx.repoRoot,
      cwd: params.cwd,
      command: params.command,
      payload: params.payload,
      toolName: params.toolName,
      agentAssessment: extractAgentAssessment(params.payload),
    })
  } catch {
    const verdict = unnormalizedGateVerdict({
      reason: 'normalization_failed',
      mode: ctx.config.mode,
      user_message: 'belay could not normalize this gated action. Run belay doctor, then retry.',
      agent_message: 'Belay denied this action because the hook payload could not be normalized.',
    })
    await deps.appendAudit(ctx, {
      event: gateAuditEventName(params.kind),
      kind: params.kind,
      verdict: verdict.verdict,
      reason: verdict.reason,
      mode: ctx.config.mode,
      wouldBlock: true,
      permission: 'deny',
    })
    return verdict
  }

  if (!gateEnabledForAction(ctx.config, action)) {
    return classifyResultToGateVerdict({
      result: {
        verdict: 'allow',
        reason: 'gate_disabled',
        fingerprint: 'gate_disabled',
        assessment: {
          reversibility: 'reversible',
          external: false,
          blastRadius: 'none',
          confidence: 1,
          signals: ['gate_disabled'],
        },
      },
      mode: ctx.config.mode,
      permission: 'allow',
      wouldBlock: false,
    })
  }

  const classifierOptions = runtimeClassifierOptions(ctx, ctx.config)
  const predicted = await classifyGatedActionAsync(action, ctx.config, classifierOptions)

  let result = predicted
  let predictedAssessment: Assessment | undefined
  let observedAssessment: Assessment | undefined
  let transactionalLayer: Record<string, unknown> | undefined

  if (
    isTransactionalEligible(ctx.config, params.kind, predicted) &&
    params.kind === 'shell' &&
    params.command
  ) {
    const transactional = ctx.config.policy.transactional
    const txResult = await runTransactionalExecution({
      command: params.command,
      cwd: params.cwd,
      repoRoot: ctx.repoRoot,
      stateDir: path.join(ctx.layout.repoLocalStateDir(ctx.repoRoot), 'transactional'),
      timeoutMs: transactional.timeoutMs,
      predicted,
      diffContext: {
        repoRoot: ctx.repoRoot,
        sensitivePaths: ctx.config.classifier.sensitivePaths,
        protectedRoots: classifierOptions.protectedArtifactRoots ?? [],
        maxDeletionCount: transactional.maxDeletionCount,
      },
    })

    if (!txResult.skipped && txResult.observed) {
      result = txResult.result
      predictedAssessment = txResult.predicted.assessment
      observedAssessment = txResult.observed.assessment
      transactionalLayer = {
        transactional: true,
        transactionalReason: txResult.observed.reason,
        transactionalCategories: txResult.observed.categories,
        transactionalChangeCount: txResult.observed.changes.length,
        transactionalTimedOut: txResult.timedOut === true,
      }
    } else if (txResult.skipReason) {
      transactionalLayer = {
        transactional: false,
        transactionalSkipReason: txResult.skipReason,
      }
    }
  }

  return gateDecisionToVerdict(ctx, deps, params.kind, result, {
    predictedAssessment,
    observedAssessment,
    transactionalLayer,
    approvalInput:
      params.kind === 'shell'
        ? {
            input: params.command ?? result.normalizedCommand ?? result.summary ?? '',
            inputKind: 'shell',
          }
        : {
            input:
              params.command ??
              result.normalizedCommand ??
              result.summary ??
              canonicalStringify(params.payload ?? {}),
            inputKind: params.kind,
          },
  })
}

/** R39: unmapped Codex tools ask via pending approval — not hard deny without approval path. */
export async function gateUnmappedToolVerdict(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  toolName: string,
  payload: Record<string, unknown>,
): Promise<GateVerdict> {
  const scrubbed = scrubValue(payload, scrubOptionsFromConfig(ctx.config))
  const result: ClassifyResult = {
    verdict: 'deny_pending_approval',
    reason: 'unmapped_tool',
    summary: toolName,
    fingerprint: toolFingerprint(toolName, scrubbed, ctx.repoRoot),
    assessment: {
      reversibility: 'irreversible',
      external: false,
      blastRadius: 'unknown Codex tool action',
      confidence: 0.5,
      signals: ['unmapped_tool'],
    },
  }
  return gateDecisionToVerdict(ctx, deps, 'tool', result, {
    approvalInput: {
      input: toolName,
      inputKind: 'tool',
    },
  })
}

async function gateDecisionToVerdict(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  kind: GatedActionKind,
  result: ClassifyResult,
  auditExtras: {
    predictedAssessment?: Assessment
    observedAssessment?: Assessment
    transactionalLayer?: Record<string, unknown>
    approvalInput?: { input: string; inputKind: 'shell' | 'tool' | 'subagent' }
  } = {},
): Promise<GateVerdict> {
  const gateBase = {
    event: gateAuditEventName(kind),
    kind,
    fingerprint: result.fingerprint,
    summary: result.normalizedCommand ?? result.summary ?? '',
    assessment: result.assessment,
    predictedAssessment: auditExtras.predictedAssessment,
    observedAssessment: auditExtras.observedAssessment,
    mode: ctx.config.mode,
    schemaVersion: result.axes ? 2 : 1,
    ...(result.axes ?? {}),
    ...auditExtras.transactionalLayer,
  }

  if (result.reason === TRANSACTIONAL_ALREADY_APPLIED) {
    const userMessage =
      'Belay executed this command safely in an isolated git worktree. Observed-safe file changes are already applied; do not retry the same command.'
    const agentMessage =
      'Belay already applied the observed-safe effects of this shell command in isolation. Do not run it again.'
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: 'allow',
      reason: result.reason,
      wouldBlock: false,
      permission: 'deny',
    })
    return classifyResultToGateVerdict({
      result,
      mode: ctx.config.mode,
      permission: 'deny',
      wouldBlock: false,
      user_message: userMessage,
      agent_message: agentMessage,
    })
  }

  const brokerActive = isCapabilityBrokerDemotionActive(ctx.config)
  let approved: Awaited<ReturnType<typeof consumeApprovedApproval>> = null
  if (
    !TRANSACTIONAL_APPROVAL_BYPASS_REASONS.has(result.reason) &&
    !shouldSkipBrokerApprovedOnce(brokerActive, result.reason)
  ) {
    const approvedState = await deps.loadApprovals(ctx, 'approved-approvals.json')
    approvedState.state = compactApprovals(approvedState.state)
    const matchedApproval = approvedState.state.approvals.find(
      (entry) =>
        entry.kind === kind &&
        entry.fingerprint === result.fingerprint &&
        entry.repoRoot === ctx.repoRoot,
    )
    if (!shouldSkipBrokerApprovedRecord(brokerActive, matchedApproval?.reason)) {
      approved = await consumeApprovedApproval(ctx, deps, kind, result.fingerprint)
    }
  }
  if (approved) {
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: 'allow',
      reason: 'approved_once',
      approvalId: approved.approvalId,
      wouldBlock: false,
      permission: 'allow',
    })
    return classifyResultToGateVerdict({
      result: { ...result, verdict: 'allow', reason: 'approved_once' },
      mode: ctx.config.mode,
      permission: 'allow',
      wouldBlock: false,
      approvalId: approved.approvalId,
    })
  }

  if (result.verdict === 'allow' || result.verdict === 'allow_flagged') {
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: result.verdict,
      reason: result.reason,
      wouldBlock: false,
      permission: 'allow',
    })
    return classifyResultToGateVerdict({
      result,
      mode: ctx.config.mode,
      permission: 'allow',
      wouldBlock: false,
    })
  }

  if (ctx.config.mode === 'audit') {
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: result.verdict,
      reason: result.reason,
      wouldBlock: true,
      permission: 'allow',
    })
    return classifyResultToGateVerdict({
      result,
      mode: ctx.config.mode,
      permission: 'allow',
      wouldBlock: true,
    })
  }

  const approval = await ensurePendingApproval(ctx, deps, kind, result, auditExtras.approvalInput)
  let approvalToken: string | undefined
  try {
    approvalToken = await issueApprovalToken(
      {
        approvalId: approval.approvalId,
        fingerprint: approval.fingerprint,
        repoRoot: approval.repoRoot,
        issuedAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      },
      configuredControlPlaneDir(ctx.config),
    )
  } catch {
    approvalToken = undefined
  }

  if (ctx.config.notifications.webhookUrl || ctx.config.notifications.commandHook) {
    await notifyDeny(ctx.config.notifications, {
      approvalId: approval.approvalId,
      reason: result.reason,
      summary: result.normalizedCommand ?? result.summary ?? '',
      repoRoot: ctx.repoRoot,
      fingerprint: result.fingerprint,
      approvalToken,
    })
  }

  await deps.appendAudit(ctx, {
    ...gateBase,
    verdict: result.verdict,
    reason: result.reason,
    approvalId: approval.approvalId,
    wouldBlock: true,
    permission: 'deny',
  })

  return classifyResultToGateVerdict({
    result,
    mode: ctx.config.mode,
    permission: 'deny',
    wouldBlock: true,
    approvalId: approval.approvalId,
    user_message: `Belay blocked this high-risk action. Approval ID: ${approval.approvalId}. ${buildRetryInstruction(ctx.config.tokenPrefix, approval.approvalId)} For details, run belay explain or /belay why.`,
    agent_message: `Belay denied this action as ${result.reason}. Wait for approval, then retry the exact same action once.`,
  })
}

export async function processApprovalPrompt(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  prompt: string,
): Promise<{ continue: boolean; user_message?: string }> {
  const approvalId = approvalCommandMatch(prompt, ctx.config.tokenPrefix)
  if (!approvalId) {
    return { continue: true }
  }

  if (ctx.config.approvalSigning.required) {
    const message =
      `Signed approval token required for ${approvalId}. Editor prompt approval is disabled in this configuration. ` +
      `Use belay approve --approval-id ${approvalId} --token <signed-token>.`
    await deps.appendAudit(ctx, {
      event: 'approval',
      kind: 'approval',
      verdict: 'deny_pending_approval',
      approvalId,
      reason: 'approval_prompt_signing_required',
      summary: prompt,
    })
    return {
      continue: false,
      user_message: message,
    }
  }

  const recorded = await recordApproval({
    approvalId,
    config: ctx.config,
    requireSignedToken: ctx.config.approvalSigning.required,
    store: {
      loadPending: () => deps.loadApprovals(ctx, 'pending-approvals.json'),
      loadApproved: () => deps.loadApprovals(ctx, 'approved-approvals.json'),
      writePending: (filePath, state) => deps.writeApprovals(filePath, state),
      writeApproved: (filePath, state) => deps.writeApprovals(filePath, state),
    },
  })

  await deps.appendAudit(ctx, {
    event: 'approval',
    kind: 'approval',
    verdict: recorded.ok ? 'allow' : 'deny_pending_approval',
    approvalId,
    reason: recorded.ok ? 'approval_recorded' : 'approval_missing',
    summary: prompt,
  })

  if (!recorded.ok) {
    return {
      continue: false,
      user_message: recorded.message,
    }
  }

  return {
    continue: false,
    user_message: recorded.message,
  }
}

export function gateVerdictToCursorResponse(verdict: GateVerdict): GatePermissionResponse {
  return {
    permission: verdict.permission,
    user_message: verdict.user_message,
    agent_message: verdict.agent_message,
  }
}

export function gateVerdictToClaudePreToolUseResponse(
  verdict: GateVerdict,
): Record<string, unknown> {
  if (verdict.permission === 'allow') {
    return {}
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        verdict.user_message ??
        verdict.agent_message ??
        `Belay denied this action (${verdict.reason}).`,
    },
  }
}

export function gateVerdictToClaudeUserPromptResponse(verdict: {
  continue: boolean
  user_message?: string
}): Record<string, unknown> {
  if (verdict.continue) {
    return {}
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      continue: false,
      user_message: verdict.user_message,
    },
  }
}

// Codex PreToolUse deny contract is identical to Claude's
// (`hookSpecificOutput.permissionDecision: "deny"` / exit 2). Reuse the same shape.
export function gateVerdictToCodexPreToolUseResponse(
  verdict: GateVerdict,
): Record<string, unknown> {
  return gateVerdictToClaudePreToolUseResponse(verdict)
}

// Codex UserPromptSubmit blocks via `decision: "block"` (per developers.openai.com/codex/hooks).
export function gateVerdictToCodexUserPromptResponse(verdict: {
  continue: boolean
  user_message?: string
}): Record<string, unknown> {
  if (verdict.continue) {
    return {}
  }
  return {
    decision: 'block',
    reason: verdict.user_message,
  }
}

export async function appendObservedAudit(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await deps.appendAudit(ctx, {
    event: eventName,
    kind: 'audit',
    verdict: 'allow',
    reason: 'observed',
    summary: canonicalStringify(payload),
  })
}

export { GateNormalizationError }
