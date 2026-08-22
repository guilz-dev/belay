import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compactApprovals, createApprovalRecordWithEnvelope } from '../../core/approval.js'
import {
  type ApprovalReplayHint,
  buildReplayHint,
  buildRetryInstructionForConfig,
  canAutoReplay,
  getExecutionLeaseMs,
  type ReplayActionContext,
  type ReplayAdapterId,
  validateReplayEnvelope,
} from '../../core/approval-replay.js'
import {
  claimApprovedForReplay,
  gateApprovalStoreFromDeps,
  recordApproval,
} from '../../core/approval-service.js'
import { issueApprovalToken } from '../../core/approval-token.js'
import {
  buildAuditActionSnapshot,
  buildAuditReplayContext,
} from '../../core/audit-replay-context.js'
import { approvalCorrelationId, serializeAuditRecordV3 } from '../../core/audit-serialize.js'
import { boundedUtf8Tail } from '../../core/bounded-output.js'
import { mutateApprovalStateWithRetry } from '../../core/capability/approval-state-mutation.js'
import { APPROVAL_STATE_VERSION_V3 } from '../../core/capability/approval-v3.js'
import { readSignedAttestationFile } from '../../core/capability/boundary-attestation-sign.js'
import { isEgressProxyActive } from '../../core/capability/boundary-egress.js'
import {
  isBoundaryCleanupError,
  safeBoundaryCleanupResourceId,
} from '../../core/capability/boundary-run.js'
import {
  boundaryAttestationPath,
  resolveBoundaryDriverContext,
  runBoundaryAgentCommand,
} from '../../core/capability/boundary-session.js'
import { hashCapabilityRequests } from '../../core/capability/capability-request-hash.js'
import {
  recordGateApprovalAsk,
  scheduleGateShadowAudit,
} from '../../core/capability/gate-shadow-audit.js'
import { canConsumeCapabilityGrantLease } from '../../core/capability/grant-consumption.js'
import {
  approvalGrantBundleExhausted,
  consumeApprovedRecordGrantBundle,
  consumeGrantLeasesForRequests,
  decrementApprovalLegacyGrant,
  type GrantBundleValidationFailureReason,
  grantsFromApproval,
  validateAndConsumeGrantBundle,
  validateGrantBundleForLeaseReuse,
} from '../../core/capability/grant-lease.js'
import { loadClassifierAuthorization } from '../../core/capability/grant-loader.js'
import {
  collectOutsideRepoPaths,
  collectOutsideRepoPathsFromToolPayload,
  fsScopeAllowlistPath,
  isCapabilityBrokerDemotionActive,
  loadFsScopeAllowlistSync,
  loadTrustedWorkspaceRootsSync,
  shouldSkipBrokerApprovedOnce,
  shouldSkipBrokerApprovedRecord,
  trustedWorkspaceRootsPath,
  validateTrustedWorkspaceRootCandidate,
} from '../../core/capability/index.js'
import { resolveLayeredConfig, teamConfigPath } from '../../core/config-layers.js'
import {
  ContainedDockerBoundaryUnavailableError,
  type ExecuteContainedDockerParams,
  executeContainedDocker,
} from '../../core/contained-execution/docker.js'
import { isContainedUnknownExecutionEligible } from '../../core/contained-execution/eligibility.js'
import { ContainedExecutionFailureError } from '../../core/contained-execution/failure.js'
import {
  type ContainedExecutionMirrorHandle,
  type ContainedExecutionMirrorOptions,
  withContainedExecutionMirror,
} from '../../core/contained-execution/mirror.js'
import {
  CONTAINED_EXECUTION_OUTPUT_SCRUB_OPTIONS,
  isContainedExecutionApprovalFallbackReason,
} from '../../core/contained-execution/policy.js'
import { effectPlanAuditFields, hashEffectPlan } from '../../core/effect-ir/audit.js'
import { buildCapabilityEffectPlan } from '../../core/effect-ir/build.js'
import {
  classifyResultToGateVerdict,
  type GatedAction,
  type GatedActionKind,
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
  approvalCommandMatch,
  approvedApprovalsFile,
  type BelayConfigV3,
  belayStateDir,
  type ClassifyResult,
  canonicalStringify,
  classifierOptionsFromConfig,
  configuredControlPlaneDir,
  hashValue,
  pendingApprovalsFile,
  resolveControlPlaneDir,
  scrubOptionsFromConfig,
  scrubString,
  scrubValue,
  toolFingerprint,
} from '../../core/index.js'
import {
  extractJudgeFallbackReason,
  formatJudgeInfrastructureDenyMessage,
  inferProviderIdFromFallbackReason,
  isJudgeInfrastructureFailure,
} from '../../core/judge-fallback-hints.js'
import { notifyDeny } from '../../core/notify.js'
import { canonicalPath } from '../../core/path-utils.js'
import {
  recoveryFailClosedResult,
  recoveryFailReasonFromSkip,
} from '../../core/recovery/fail-closed.js'
import { fingerprintReplayPayload } from '../../core/replay-scrub.js'
import {
  FILE_CHECKPOINT_ISOLATION_UNAVAILABLE,
  isTransactionalEligible,
  runTransactionalExecution,
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPROVAL_BYPASS_REASONS,
} from '../../core/transactional/index.js'
import type {
  ApprovalRecord,
  ApprovalScopeHint,
  ApprovalStateFile,
  Assessment,
  ClassifierOptions,
} from '../../core/types.js'
import { buildAuditProvenanceFields } from '../../runtime-provenance.js'
import { egressStatus } from '../../services/egress-service.js'
import { protectedArtifactRoots } from '../layouts/protected-paths.js'
import type { AdapterLayout } from '../layouts/types.js'

const EMPTY_APPROVALS: ApprovalStateFile = {
  version: 1,
  approvals: [],
}

const RUNTIME_PROVENANCE_KEY = Symbol.for('agent-belay.runtime-provenance')

interface RuntimeBuildProvenance {
  runtimeVersion?: unknown
  runtimeBuildStamp?: unknown
  runtimeArtifactHash?: unknown
}

function auditProvenance(config: BelayConfigV3): Record<string, string> {
  const runtime = (globalThis as Record<PropertyKey, unknown>)[RUNTIME_PROVENANCE_KEY] as
    | RuntimeBuildProvenance
    | undefined
  return buildAuditProvenanceFields(config, runtime)
}

function adapterIdFromContext(ctx: GateRuntimeContext): ReplayAdapterId | undefined {
  if (
    ctx.config.adapter === 'cursor' ||
    ctx.config.adapter === 'claude' ||
    ctx.config.adapter === 'codex'
  ) {
    return ctx.config.adapter
  }
  if (ctx.layout.name === 'cursor' || ctx.layout.name === 'claude' || ctx.layout.name === 'codex') {
    return ctx.layout.name
  }
  return undefined
}

function extractShellCommandFromPayload(payload: Record<string, unknown>): string {
  const toolInput = payload.tool_input
  if (!toolInput || typeof toolInput !== 'object') {
    return ''
  }
  const input = toolInput as Record<string, unknown>
  return typeof input.command === 'string' ? input.command : ''
}

export interface ApprovalPromptResult {
  continue: boolean
  user_message?: string
  replay?: ApprovalReplayHint
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
  replayApprovedShell: (
    ctx: GateRuntimeContext,
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<{
    exitCode: number | null
    timedOut: boolean
    signal: string | null
    stdout?: string
    stderr?: string
  }>
  readSignedAttestation: (filePath: string) => Promise<unknown>
  withContainedExecutionMirror: <T>(
    options: ContainedExecutionMirrorOptions,
    operation: (mirror: ContainedExecutionMirrorHandle) => Promise<T>,
  ) => Promise<T>
  executeContainedDocker: (
    params: ExecuteContainedDockerParams,
  ) => ReturnType<typeof executeContainedDocker>
}

const REPLAY_AUDIT_FAILURE_NOTE =
  ' Audit recording failed; inspect audit storage before the next approval.'

async function appendReplayAuditSafely(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  event: Record<string, unknown>,
): Promise<boolean> {
  try {
    await deps.appendAudit(ctx, event)
    return true
  } catch {
    return false
  }
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
      const provenance = auditProvenance(ctx.config)
      const record: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        mode: ctx.config.mode,
        ...event,
        ...provenance,
      }
      if (!ctx.config.audit.includeAssessment) {
        delete record.assessment
      }
      const serialized = serializeAuditRecordV3(record, scrubOptionsFromConfig(ctx.config))
      await writeFile(auditPath, `${JSON.stringify(serialized)}\n`, {
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
      const version = loaded.version === 3 ? 3 : loaded.version === 2 ? 2 : 1
      return {
        filePath,
        state: {
          version,
          ...(loaded.revision !== undefined ? { revision: loaded.revision } : {}),
          approvals: Array.isArray(loaded.approvals) ? loaded.approvals : [],
        },
      }
    },
    async writeApprovals(filePath, state) {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8')
    },
    async replayApprovedShell(ctx, command, cwd, timeoutMs) {
      return runBoundaryAgentCommand({
        repoRoot: ctx.repoRoot,
        config: ctx.config,
        command,
        cwd,
        timeoutMs,
        runOptions: { mountReadOnly: false },
      })
    },
    readSignedAttestation: readSignedAttestationFile,
    withContainedExecutionMirror,
    executeContainedDocker,
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
  const trustedRoots = loadTrustedWorkspaceRootsSync(
    trustedWorkspaceRootsPath(config, repoLocalStateDir),
  )
  return repoShellClassifierOptions(config, ctx.repoRoot, ctx.layout, {
    brokerFsScope,
    fsScopeAllowlist: brokerFsScope
      ? loadFsScopeAllowlistSync(fsScopeAllowlistPath(config, repoLocalStateDir))
      : undefined,
    trustedWorkspaceRoots: trustedRoots.roots.map((entry) => entry.path),
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

function resolveGateAuditEvent(sourceEvent: string | undefined, kind: GatedActionKind): string {
  if (!sourceEvent) {
    return gateAuditEventName(kind)
  }
  switch (sourceEvent.toLowerCase()) {
    case 'beforeshellexecution':
      return 'beforeShellExecution'
    case 'pretooluse':
      return 'preToolUse'
    case 'subagentstart':
    case 'subagentgate':
      return 'subagentGate'
    default:
      return gateAuditEventName(kind)
  }
}

async function ensurePendingApproval(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  kind: GatedActionKind,
  result: ClassifyResult,
  approvalInput?: {
    input: string
    inputKind: 'shell' | 'tool' | 'subagent'
    cwd?: string
    toolName?: string
    payload?: Record<string, unknown>
  },
  scopeHint?: ApprovalScopeHint,
): Promise<{
  approval: Awaited<ReturnType<typeof createApprovalRecordWithEnvelope>>
  created: boolean
}> {
  const candidate = createApprovalRecordWithEnvelope({
    kind,
    fingerprint: result.fingerprint,
    repoRoot: ctx.repoRoot,
    reason: result.reason,
    summary: result.normalizedCommand ?? result.summary ?? '',
    approvalTtlMinutes: ctx.config.approvalTtlMinutes,
    approvalId: `belay_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    approvalInput,
    scopeHint,
    capabilityRequests: result.capabilityRequests,
    effectPlanHash: result.effectPlan ? hashEffectPlan(result.effectPlan) : undefined,
  })
  const outcome = await mutateApprovalStateWithRetry<{
    approval: typeof candidate
    created: boolean
  }>({
    load: () => deps.loadApprovals(ctx, 'pending-approvals.json'),
    write: (filePath, state) => deps.writeApprovals(filePath, state),
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const existing = compacted.approvals.find(
        (approval) =>
          approval.kind === kind &&
          approval.fingerprint === result.fingerprint &&
          approval.repoRoot === ctx.repoRoot,
      )
      if (existing) {
        return { state: compacted, result: { approval: existing, created: false } }
      }
      compacted.version = APPROVAL_STATE_VERSION_V3
      compacted.approvals.push(candidate)
      return { state: compacted, result: { approval: candidate, created: true } }
    },
  })
  if (!outcome) {
    throw new Error('Failed to persist pending approval')
  }
  return outcome
}

function deriveWorkspaceRootScopeHint(params: {
  result: ClassifyResult
  replayAction?: ReplayActionContext
  payloadForScopeHint?: Record<string, unknown>
  options: ClassifierOptions
}): ApprovalScopeHint | undefined {
  if (
    params.result.reason !== 'outside_repo_mutation' &&
    params.result.reason !== 'outside_repo_redirect'
  ) {
    return undefined
  }
  const action = params.replayAction
  if (!action?.cwd) {
    return undefined
  }

  const outsidePaths = new Set<string>()
  if (action.kind === 'shell' && action.command) {
    for (const resolved of collectOutsideRepoPaths(
      action.command,
      action.cwd,
      action.repoRoot,
      params.options.trustedWorkspaceRoots,
    )) {
      outsidePaths.add(resolved)
    }
  } else if (action.kind === 'tool') {
    const toolPayload = params.payloadForScopeHint ?? action.payload ?? {}
    for (const resolved of collectOutsideRepoPathsFromToolPayload(
      toolPayload,
      action.cwd,
      action.repoRoot,
      params.options.trustedWorkspaceRoots,
    )) {
      outsidePaths.add(resolved)
    }
    const command = extractShellCommandFromPayload(toolPayload)
    if (command) {
      for (const resolved of collectOutsideRepoPaths(
        command,
        action.cwd,
        action.repoRoot,
        params.options.trustedWorkspaceRoots,
      )) {
        outsidePaths.add(resolved)
      }
    }
  }

  if (outsidePaths.size !== 1) {
    return undefined
  }
  const targetPath = [...outsidePaths][0]
  if (!targetPath) {
    return undefined
  }
  const candidateRoot = canonicalPath(path.dirname(targetPath))
  const validation = validateTrustedWorkspaceRootCandidate({
    candidatePath: candidateRoot,
    repoRoot: action.repoRoot,
    controlPlaneDir: params.options.controlPlaneDir ?? undefined,
    protectedRoots: params.options.protectedArtifactRoots ?? [],
    requireExistingDirectory: true,
    requireNonGit: true,
  })
  if (!validation.ok) {
    return undefined
  }
  return { scope: 'workspace-root', path: validation.normalizedPath }
}

type ApprovalConsumeMutationResult =
  | { status: 'consumed'; approval: ApprovalRecord; firstExecution: boolean }
  | {
      status: 'invalid_bundle'
      approval: ApprovalRecord
      reason: GrantBundleValidationFailureReason
    }
  | null

async function consumeApprovedApproval(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  kind: GatedActionKind,
  fingerprint: string,
  requests: NonNullable<ClassifyResult['capabilityRequests']>,
): Promise<
  | { status: 'consumed'; approval: ApprovalRecord; firstExecution: boolean }
  | {
      status: 'invalid_bundle'
      approval: ApprovalRecord
      reason: GrantBundleValidationFailureReason
    }
  | null
> {
  const consumed = await mutateApprovalStateWithRetry<ApprovalConsumeMutationResult>({
    load: () => deps.loadApprovals(ctx, 'approved-approvals.json'),
    write: (filePath, state) => deps.writeApprovals(filePath, state),
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const matchIndex = compacted.approvals.findIndex(
        (approval) =>
          approval.kind === kind &&
          approval.fingerprint === fingerprint &&
          approval.repoRoot === ctx.repoRoot,
      )
      if (matchIndex === -1) {
        return { state: compacted, result: null }
      }

      const approval = compacted.approvals[matchIndex]
      if (approval.executionLeaseExpiresAt) {
        if (approval.grantBundleVersion === 1) {
          const validated = validateGrantBundleForLeaseReuse(approval, requests)
          if (!validated.ok) {
            compacted.approvals.splice(matchIndex, 1)
            return {
              state: compacted,
              result: { status: 'invalid_bundle' as const, approval, reason: validated.reason },
            }
          }
        }
        return {
          state: compacted,
          result: { status: 'consumed' as const, approval, firstExecution: false },
        }
      }
      if (approvalGrantBundleExhausted(approval) && !approval.executionLeaseExpiresAt) {
        compacted.approvals.splice(matchIndex, 1)
        return { state: compacted, result: null }
      }

      let updatedApproval = approval
      const bundle = grantsFromApproval(approval)
      if (approval.grantBundleVersion === 1) {
        const validated = validateAndConsumeGrantBundle(approval, requests)
        if (!validated.ok) {
          compacted.approvals.splice(matchIndex, 1)
          return {
            state: compacted,
            result: { status: 'invalid_bundle' as const, approval, reason: validated.reason },
          }
        }
        updatedApproval = validated.approval
      } else if (bundle.length > 0) {
        const consumed = consumeApprovedRecordGrantBundle(approval)
        if (!consumed.consumed) {
          return { state: compacted, result: null }
        }
        updatedApproval = consumed.approval
      } else if (approval.grant) {
        updatedApproval = decrementApprovalLegacyGrant(approval)
      }

      compacted.approvals[matchIndex] = {
        ...updatedApproval,
        executionLeaseExpiresAt: new Date(
          Date.now() + getExecutionLeaseMs(ctx.config),
        ).toISOString(),
      }
      return {
        state: compacted,
        result: { status: 'consumed' as const, approval: updatedApproval, firstExecution: true },
      }
    },
  })
  if (!consumed) {
    return null
  }
  return consumed
}

async function discardApprovedApproval(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  approvalId: string,
): Promise<void> {
  const discarded = await mutateApprovalStateWithRetry({
    load: () => deps.loadApprovals(ctx, 'approved-approvals.json'),
    write: (filePath, state) => deps.writeApprovals(filePath, state),
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const index = compacted.approvals.findIndex((approval) => approval.approvalId === approvalId)
      if (index !== -1) {
        compacted.approvals.splice(index, 1)
      }
      return { state: compacted, result: true }
    },
  })
  if (discarded !== true) {
    throw new Error(`Failed to discard rejected approval ${approvalId}`)
  }
}

function scrubMediatedOutput(value: string): { value: string; truncated: boolean } {
  const source = boundedUtf8Tail(value)
  const scrubbed = boundedUtf8Tail(
    scrubString(source.value, CONTAINED_EXECUTION_OUTPUT_SCRUB_OPTIONS),
  )
  return { value: scrubbed.value, truncated: source.truncated || scrubbed.truncated }
}

function normalizeContainedFailure(error: unknown): ContainedExecutionFailureError {
  if (error instanceof ContainedExecutionFailureError) {
    return error
  }
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return new ContainedExecutionFailureError('contained_execution_capability_invalid', {
      cause: error,
    })
  }
  return new ContainedExecutionFailureError('contained_execution_boundary_failed', { cause: error })
}

function containedAuditBase(
  kind: GatedActionKind,
  mode: 'enforce' | 'audit',
  result: ClassifyResult,
  sourceEvent?: string,
): Record<string, unknown> {
  const planFields = effectPlanAuditFields(result.effectPlan)
  const rawSourceEvent = sourceEvent ?? gateAuditEventName(kind)
  const auditEvent = resolveGateAuditEvent(rawSourceEvent, kind)
  return {
    event: auditEvent,
    sourceEvent: rawSourceEvent,
    kind,
    fingerprint: result.fingerprint,
    mode,
    schemaVersion: result.axes ? 2 : 1,
    effectPlanVersion: planFields.effectPlanVersion,
    effectIRHash: planFields.effectIRHash,
    effectPlanSignals: planFields.effectPlanSignals,
    effectPlanOpacity: planFields.effectPlanOpacity,
    effectPlanDisposition: planFields.effectPlanDisposition,
    effectPlanCompleteness: planFields.effectPlanCompleteness,
    wouldMediate: true,
  }
}

async function mediateContainedUnknownExecution(params: {
  ctx: GateRuntimeContext
  deps: GateRuntimeDeps
  action: GatedAction
  command: string
  result: ClassifyResult
  sourceEvent?: string
}): Promise<GateVerdict | null> {
  const { ctx, deps, action, command, sourceEvent } = params
  const result = { ...params.result, wouldMediate: true }
  if (ctx.config.mode === 'audit') {
    await deps.appendAudit(ctx, {
      ...containedAuditBase(action.kind, ctx.config.mode, result, sourceEvent),
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

  const controlPlaneDir = configuredControlPlaneDir(ctx.config)
  const attestationPath = boundaryAttestationPath(ctx.repoRoot, ctx.config)
  const protectedRoots = [
    ...new Set([
      ...protectedArtifactRoots(ctx.layout, ctx.repoRoot, controlPlaneDir),
      attestationPath,
    ]),
  ]
  const checkpoint = ctx.config.policy.transactional.fileCheckpoint
  const containedConfig = ctx.config.sandbox.containedExecution
  if (!containedConfig?.enabled) {
    return null
  }
  let execution: Awaited<ReturnType<GateRuntimeDeps['executeContainedDocker']>> | undefined
  let mirrorBackend: ContainedExecutionMirrorHandle['backend'] | undefined
  try {
    let signedAttestation: unknown
    try {
      signedAttestation = await deps.readSignedAttestation(attestationPath)
    } catch (error) {
      throw new ContainedExecutionFailureError('contained_execution_capability_invalid', {
        cause: error,
      })
    }
    execution = await deps.withContainedExecutionMirror(
      {
        sourceRoot: ctx.repoRoot,
        controlPlaneRoots: protectedRoots,
        limits: {
          maxFiles: checkpoint.maxFiles,
          maxSourceBytes: checkpoint.maxSourceBytes,
          maxWorkspaceBytes: checkpoint.maxWorkspaceBytes,
          prepareTimeoutMs: checkpoint.prepareTimeoutMs,
        },
      },
      async (mirror) => {
        mirrorBackend = mirror.backend
        return deps.executeContainedDocker({
          repoRoot: ctx.repoRoot,
          controlPlaneDir,
          protectedRoots,
          config: containedConfig,
          mirror,
          guestCwd: action.cwd,
          command,
          inputFingerprint: result.fingerprint,
          signedAttestation,
        })
      },
    )
  } catch (error) {
    if (
      error instanceof ContainedDockerBoundaryUnavailableError &&
      isContainedExecutionApprovalFallbackReason(error.reason)
    ) {
      return null
    }
    const failure = normalizeContainedFailure(error)
    const reason = failure.code
    const failedResult: ClassifyResult = {
      ...result,
      verdict: 'deny_pending_approval',
      reason,
    }
    await deps.appendAudit(ctx, {
      ...containedAuditBase(action.kind, ctx.config.mode, failedResult, sourceEvent),
      verdict: failedResult.verdict,
      reason,
      wouldBlock: true,
      permission: 'deny',
      ...(mirrorBackend ? { mirrorBackend } : {}),
    })
    const sessionHint =
      failure.remediation === 'session-start' ? ' Run `belay session start`, then retry.' : ''
    return classifyResultToGateVerdict({
      result: failedResult,
      mode: ctx.config.mode,
      permission: 'deny',
      wouldBlock: true,
      user_message: `Belay could not confirm safe contained execution (${reason}).${sessionHint}`,
      agent_message:
        `Belay denied the original host command because contained execution failed closed (${reason}).` +
        sessionHint,
    })
  }

  const stdout = scrubMediatedOutput(execution.stdout)
  const stderr = scrubMediatedOutput(execution.stderr)
  const mediatedExecution = {
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    stdout: stdout.value,
    stderr: stderr.value,
    stdoutTruncated: execution.stdoutTruncated || stdout.truncated,
    stderrTruncated: execution.stderrTruncated || stderr.truncated,
    receiptHash: execution.receiptHash,
    workspaceChangesDiscarded: true as const,
  }
  const reason =
    execution.exitCode === 0 && !execution.timedOut
      ? 'contained_execution_complete'
      : 'contained_execution_failed'
  const mediatedResult: ClassifyResult = {
    ...result,
    verdict: 'allow',
    reason,
    mediatedExecution,
  }
  await deps.appendAudit(ctx, {
    ...containedAuditBase(action.kind, ctx.config.mode, mediatedResult, sourceEvent),
    verdict: mediatedResult.verdict,
    reason,
    wouldBlock: false,
    permission: 'deny',
    receiptHash: execution.receiptHash,
    imageId: execution.receipt.imageId,
    mirrorBackend,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
  })

  const status = execution.timedOut
    ? 'timed out'
    : execution.exitCode === 0
      ? 'completed successfully'
      : `failed with exit ${execution.exitCode}`
  const output = [
    mediatedExecution.stdout
      ? `stdout tail${mediatedExecution.stdoutTruncated ? ' (truncated)' : ''}:\n${mediatedExecution.stdout}`
      : '',
    mediatedExecution.stderr
      ? `stderr tail${mediatedExecution.stderrTruncated ? ' (truncated)' : ''}:\n${mediatedExecution.stderr}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  return classifyResultToGateVerdict({
    result: mediatedResult,
    mode: ctx.config.mode,
    permission: 'deny',
    wouldBlock: false,
    user_message:
      `Belay contained execution ${status}; the original host command was not run and workspace changes were discarded. Receipt: ${execution.receiptHash}.` +
      (output ? `\n${output}` : ''),
    agent_message:
      `Belay already ran this command once inside the contained boundary (${status}). Do not retry it on the host. Receipt: ${execution.receiptHash}.` +
      (output ? `\n${output}` : ''),
  })
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
    sourceEvent?: string
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
    const scrubbedInput = scrubValue(
      {
        kind: params.kind,
        cwd: params.cwd,
        command: params.command,
        payload: params.payload,
        toolName: params.toolName,
      },
      scrubOptionsFromConfig(ctx.config),
    )
    const inputFingerprint = hashValue(
      `unnormalized-gated-action:v1:${canonicalStringify(scrubbedInput)}`,
    )
    const verdict: GateVerdict = {
      ...unnormalizedGateVerdict({
        reason: 'normalization_failed',
        mode: ctx.config.mode,
        user_message: 'belay could not normalize this gated action. Run belay doctor, then retry.',
        agent_message: 'Belay denied this action because the hook payload could not be normalized.',
      }),
      fingerprint: inputFingerprint,
      effectPlan: buildCapabilityEffectPlan({
        actionKind: params.kind,
        summary: params.command ?? params.toolName ?? params.kind,
        inputFingerprint,
        requests: [],
        effectFree: false,
      }),
    }
    const sourceEvent = params.sourceEvent ?? gateAuditEventName(params.kind)
    await deps.appendAudit(ctx, {
      event: resolveGateAuditEvent(sourceEvent, params.kind),
      sourceEvent,
      kind: params.kind,
      fingerprint: verdict.fingerprint,
      verdict: verdict.verdict,
      reason: verdict.reason,
      mode: ctx.config.mode,
      ...effectPlanAuditFields(verdict.effectPlan),
      wouldBlock: true,
      permission: 'deny',
    })
    return verdict
  }

  if (!gateEnabledForAction(ctx.config, action)) {
    const result: ClassifyResult = {
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
      effectPlan: buildCapabilityEffectPlan({
        actionKind: action.kind,
        summary: action.command ?? action.toolName ?? action.kind,
        inputFingerprint: 'gate_disabled',
        requests: [],
        effectFree: false,
      }),
    }
    return classifyResultToGateVerdict({
      result,
      mode: ctx.config.mode,
      permission: 'allow',
      wouldBlock: false,
    })
  }

  const classifierOptions = runtimeClassifierOptions(ctx, ctx.config)
  const approvedForAuth = await deps.loadApprovals(ctx, 'approved-approvals.json')
  const authorization = await loadClassifierAuthorization({
    repoRoot: ctx.repoRoot,
    config: ctx.config,
    approvedState: compactApprovals(approvedForAuth.state),
  })
  const egress = await egressStatus({ targetDir: ctx.repoRoot })
  const egressProxyActive = isEgressProxyActive({
    config: ctx.config,
    running: egress.running,
    foreignProxy: egress.foreignProxy,
    repoRootMismatch: egress.repoRootMismatch,
  })
  const enrichedClassifierOptions = {
    ...classifierOptions,
    ...authorization,
    egressProxyActive,
  }
  const predicted = await classifyGatedActionAsync(action, ctx.config, enrichedClassifierOptions)

  if (
    action.kind === 'shell' &&
    action.command &&
    isContainedUnknownExecutionEligible(ctx.config, action, predicted)
  ) {
    const mediated = await mediateContainedUnknownExecution({
      ctx,
      deps,
      action,
      command: action.command,
      result: predicted,
      sourceEvent: params.sourceEvent,
    })
    if (mediated) {
      return mediated
    }
  }

  let result = predicted
  let predictedAssessment: Assessment | undefined
  let observedAssessment: Assessment | undefined
  let transactionalLayer: Record<string, unknown> | undefined
  const recoveryCandidate =
    isTransactionalEligible(ctx.config, params.kind, predicted) &&
    params.kind === 'shell' &&
    Boolean(params.command)

  if (recoveryCandidate && params.command) {
    const transactional = ctx.config.policy.transactional
    const boundaryDriverId =
      ctx.config.capability?.boundaryDriver ??
      (ctx.config.sandbox.runtime === 'container' ? 'container' : 'host-integration')
    const boundaryContext = await resolveBoundaryDriverContext({
      repoRoot: ctx.repoRoot,
      config: ctx.config,
      driverId: boundaryDriverId,
      egressProxyRunning: egressProxyActive,
    })
    const txResult = await runTransactionalExecution({
      command: params.command,
      cwd: params.cwd,
      repoRoot: ctx.repoRoot,
      stateDir: belayStateDir(ctx.config, ctx.layout.repoLocalStateDir(ctx.repoRoot)),
      timeoutMs: transactional.timeoutMs,
      predicted,
      diffContext: {
        repoRoot: ctx.repoRoot,
        sensitivePaths: ctx.config.classifier.sensitivePaths,
        protectedRoots: enrichedClassifierOptions.protectedArtifactRoots ?? [],
        maxDeletionCount: transactional.maxDeletionCount,
      },
      boundaryContext,
      dirtyIgnoreRoots: protectedArtifactRoots(
        ctx.layout,
        ctx.repoRoot,
        ctx.config.controlPlane.enabled ? configuredControlPlaneDir(ctx.config) : null,
      ),
      fileCheckpoint: transactional.fileCheckpoint,
      checkpoint: transactional.checkpoint,
    })

    if (!txResult.skipped && txResult.observed) {
      result = txResult.result
      predictedAssessment = txResult.predicted.assessment
      observedAssessment = txResult.observed.assessment
      transactionalLayer = {
        transactional: true,
        transactionalBackend: txResult.transactionalBackend,
        resourceKind: txResult.resourceKind,
        baselineTreeHash: txResult.baselineTreeHash,
        snapshotFileCount: txResult.snapshotFileCount,
        snapshotSourceBytes: txResult.snapshotSourceBytes,
        snapshotWorkspaceBytes: txResult.snapshotWorkspaceBytes,
        snapshotCopyStrategy: txResult.snapshotCopyStrategy,
        snapshotPrepareMs: txResult.snapshotPrepareMs,
        executionRoute: `boundary:${boundaryContext.driverId}`,
        enforcementStatus: 'mediated_unattested',
        transactionalReason: txResult.observed.reason,
        transactionalCategories: txResult.observed.categories,
        transactionalChangeCount: txResult.observed.changes.length,
        transactionalTimedOut: txResult.timedOut === true,
        ...(txResult.recoveryCheckpointId
          ? {
              recoveryCheckpointId: txResult.recoveryCheckpointId,
              recoveryBackend: txResult.recoveryBackend,
              recoveryProofHash: txResult.recoveryProofHash,
              recoveryState: txResult.recoveryState,
            }
          : {}),
      }
    } else {
      const skipReason = txResult.skipReason ?? 'recovery_observation_failed'
      const failReason =
        skipReason === FILE_CHECKPOINT_ISOLATION_UNAVAILABLE
          ? FILE_CHECKPOINT_ISOLATION_UNAVAILABLE
          : recoveryFailReasonFromSkip(skipReason)
      result = recoveryFailClosedResult(predicted, failReason, [skipReason])
      transactionalLayer = {
        transactional: false,
        transactionalBackend: txResult.transactionalBackend,
        resourceKind: txResult.resourceKind,
        baselineTreeHash: txResult.baselineTreeHash,
        snapshotFileCount: txResult.snapshotFileCount,
        snapshotSourceBytes: txResult.snapshotSourceBytes,
        snapshotWorkspaceBytes: txResult.snapshotWorkspaceBytes,
        snapshotCopyStrategy: txResult.snapshotCopyStrategy,
        snapshotPrepareMs: txResult.snapshotPrepareMs,
        transactionalSkipReason: skipReason,
        transactionalSkipDetail: txResult.skipDetail,
        recoveryFailClosed: true,
      }
    }
  }

  const scrubOpts = scrubOptionsFromConfig(ctx.config)
  const scrubbedPayload = fingerprintReplayPayload(params.kind, params.payload, scrubOpts)

  return gateDecisionToVerdict(ctx, deps, params.kind, result, {
    sourceEvent: params.sourceEvent,
    predictedAssessment,
    observedAssessment,
    transactionalLayer,
    approvalInput:
      params.kind === 'shell'
        ? {
            input: params.command ?? result.normalizedCommand ?? result.summary ?? '',
            inputKind: 'shell',
            cwd: params.cwd,
          }
        : {
            input:
              params.command ??
              result.normalizedCommand ??
              result.summary ??
              canonicalStringify(scrubbedPayload ?? {}),
            inputKind: params.kind,
            cwd: params.cwd,
            toolName: params.toolName,
            payload: scrubbedPayload,
          },
    replayAction: {
      kind: params.kind,
      cwd: params.cwd,
      toolName: params.toolName,
      command: params.command,
      payload: scrubbedPayload,
      fingerprint: result.fingerprint,
      repoRoot: ctx.repoRoot,
    },
    classifierOptions: enrichedClassifierOptions,
    scopeHintPayload: params.payload,
  })
}

/** R39: unmapped Codex tools ask via pending approval — not hard deny without approval path. */
export async function gateUnmappedToolVerdict(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  toolName: string,
  payload: Record<string, unknown>,
): Promise<GateVerdict> {
  const scrubOpts = scrubOptionsFromConfig(ctx.config)
  const replayPayload = fingerprintReplayPayload('tool', payload, scrubOpts) ?? {}
  const result: ClassifyResult = {
    verdict: 'deny_pending_approval',
    reason: 'unmapped_tool',
    summary: toolName,
    fingerprint: toolFingerprint(toolName, replayPayload, ctx.repoRoot),
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
      cwd: ctx.repoRoot,
      toolName,
      payload: replayPayload,
    },
    replayAction: {
      kind: 'tool',
      cwd: ctx.repoRoot,
      toolName,
      payload: replayPayload,
      fingerprint: result.fingerprint,
      repoRoot: ctx.repoRoot,
    },
  })
}

async function consumeCapabilityGrantIfUsed(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  result: ClassifyResult,
): Promise<boolean> {
  if (
    result.reason !== 'capability_grant' &&
    result.authorizationDecision?.matchedRule !== 'grant.exact'
  ) {
    return true
  }
  if (!canConsumeCapabilityGrantLease(result)) {
    return false
  }
  const requests = result.capabilityRequests ?? []
  if (!requests.length) {
    return true
  }
  const consumed = await mutateApprovalStateWithRetry({
    load: () => deps.loadApprovals(ctx, 'approved-approvals.json'),
    write: (filePath, state) => deps.writeApprovals(filePath, state),
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const lease = consumeGrantLeasesForRequests(compacted, requests)
      if (!lease.consumed) {
        return null
      }
      return { state: lease.state, result: true }
    },
  })
  return consumed === true
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
    approvalInput?: {
      input: string
      inputKind: 'shell' | 'tool' | 'subagent'
      cwd?: string
      toolName?: string
      payload?: Record<string, unknown>
    }
    replayAction?: ReplayActionContext
    classifierOptions?: ClassifierOptions
    scopeHintPayload?: Record<string, unknown>
    sourceEvent?: string
  } = {},
): Promise<GateVerdict> {
  if (!result.effectPlan) {
    result = {
      ...result,
      effectPlan: buildCapabilityEffectPlan({
        actionKind: kind,
        summary: result.normalizedCommand ?? result.summary ?? kind,
        inputFingerprint: result.fingerprint,
        requests: result.capabilityRequests ?? [],
        effectFree: result.reason === 'read_only',
      }),
    }
  }
  const replayContext = buildAuditReplayContext(kind, result, auditExtras.replayAction)
  const actionSnapshot = buildAuditActionSnapshot(kind, result, auditExtras.replayAction)
  const providerId = String(ctx.config.judge?.providerId ?? 'cursor')
  const stateDir = belayStateDir(ctx.config, ctx.layout.repoLocalStateDir(ctx.repoRoot))
  const capabilityAudit = scheduleGateShadowAudit({
    repoRoot: ctx.repoRoot,
    config: ctx.config,
    providerId,
    result,
    command:
      auditExtras.replayAction?.command ??
      (kind === 'shell' ? auditExtras.approvalInput?.input : undefined),
    stateDir,
  })
  const sourceEvent = auditExtras.sourceEvent ?? gateAuditEventName(kind)
  const auditEvent = resolveGateAuditEvent(sourceEvent, kind)
  const gateBase = {
    event: auditEvent,
    sourceEvent,
    kind,
    fingerprint: result.fingerprint,
    summary: result.normalizedCommand ?? result.summary ?? '',
    assessment: result.assessment,
    predictedAssessment: auditExtras.predictedAssessment,
    observedAssessment: auditExtras.observedAssessment,
    mode: ctx.config.mode,
    schemaVersion: result.axes ? 2 : 1,
    ...(result.axes ?? {}),
    ...capabilityAudit,
    ...auditExtras.transactionalLayer,
    ...(replayContext ? { replayContext } : {}),
    ...(actionSnapshot ? { actionSnapshot } : {}),
  }

  const denyWithPendingApproval = async (failure?: {
    reason: string
    grantBundleFailureReason?: GrantBundleValidationFailureReason
    auditFields?: Record<string, unknown> | ((approval: ApprovalRecord) => Record<string, unknown>)
    userMessage: (approvalId: string) => string
    agentMessage: string
  }): Promise<GateVerdict> => {
    const { approval, created } = await ensurePendingApproval(
      ctx,
      deps,
      kind,
      result,
      auditExtras.approvalInput,
      deriveWorkspaceRootScopeHint({
        result,
        replayAction: auditExtras.replayAction,
        payloadForScopeHint: auditExtras.scopeHintPayload,
        options: auditExtras.classifierOptions ?? {},
      }),
    )
    if (created) {
      await recordGateApprovalAsk(stateDir, result.reason, false)
    }
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

    const denialReason = failure?.reason ?? result.reason
    if (ctx.config.notifications.webhookUrl || ctx.config.notifications.commandHook) {
      await notifyDeny(ctx.config.notifications, {
        approvalId: approval.approvalId,
        reason: denialReason,
        summary: result.normalizedCommand ?? result.summary ?? '',
        repoRoot: ctx.repoRoot,
        fingerprint: result.fingerprint,
        approvalToken,
      })
    }

    const failureAuditFields =
      typeof failure?.auditFields === 'function'
        ? failure.auditFields(approval)
        : failure?.auditFields
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: failure ? 'deny_pending_approval' : result.verdict,
      reason: denialReason,
      approvalId: approval.approvalId,
      ...(failure?.grantBundleFailureReason
        ? { grantBundleFailureReason: failure.grantBundleFailureReason }
        : {}),
      ...failureAuditFields,
      wouldBlock: true,
      permission: 'deny',
    })

    const adapter = adapterIdFromContext(ctx)
    const autoReplayShell = kind === 'shell' && canAutoReplay(ctx.config, kind, adapter)
    return classifyResultToGateVerdict({
      result: failure
        ? { ...result, verdict: 'deny_pending_approval', reason: denialReason }
        : result,
      mode: ctx.config.mode,
      permission: 'deny',
      wouldBlock: true,
      approvalId: approval.approvalId,
      user_message:
        failure?.userMessage(approval.approvalId) ??
        `Belay blocked this high-risk action. Approval ID: ${approval.approvalId}. ${buildRetryInstructionForConfig(ctx.config, ctx.config.tokenPrefix, approval.approvalId, kind, adapter)} For details, run belay explain or /belay why.`,
      agent_message:
        failure?.agentMessage ??
        (autoReplayShell
          ? `Belay denied this action as ${result.reason}. Wait for approval; Belay will replay the exact shell action automatically. Do not retry unless replay fails.`
          : `Belay denied this action as ${result.reason}. Wait for approval, then retry the exact same action once.`),
    })
  }

  const denyReplayMismatch = async (
    approval: ApprovalRecord,
    mismatchKind: 'capability_requests' | 'effect_plan' | 'replay_envelope',
    messages: { user: string; agent: string },
  ): Promise<GateVerdict> => {
    await discardApprovedApproval(ctx, deps, approval.approvalId)
    return denyWithPendingApproval({
      reason: 'approval_replay_mismatch',
      auditFields: (replacement) => ({
        rejectedApprovalId: approval.approvalId,
        rejectedApprovalCorrelationId: approvalCorrelationId(approval.approvalId),
        replacementApprovalCorrelationId: approvalCorrelationId(replacement.approvalId),
        replayMismatchKind: mismatchKind,
      }),
      userMessage: (approvalId) => `${messages.user} New approval ID: ${approvalId}.`,
      agentMessage: `${messages.agent} Wait for the new exact approval, then retry once.`,
    })
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
      if (
        matchedApproval?.capabilityRequestHash &&
        (!result.capabilityRequests?.length ||
          matchedApproval.capabilityRequestHash !==
            hashCapabilityRequests(result.capabilityRequests))
      ) {
        return denyReplayMismatch(matchedApproval, 'capability_requests', {
          user: 'Belay denied this action because capability requests changed after approval. Re-approve the exact action or run belay explain.',
          agent: 'Belay denied this action because capability requests changed after approval.',
        })
      }
      if (
        matchedApproval?.effectPlanHash &&
        (!result.effectPlan || matchedApproval.effectPlanHash !== hashEffectPlan(result.effectPlan))
      ) {
        return denyReplayMismatch(matchedApproval, 'effect_plan', {
          user: 'Belay denied this action because the effect plan changed after approval. Re-approve the exact action or run belay explain.',
          agent: 'Belay denied this action because the effect plan changed after approval.',
        })
      }
      if (
        matchedApproval &&
        auditExtras.replayAction &&
        !validateReplayEnvelope(matchedApproval, auditExtras.replayAction)
      ) {
        return denyReplayMismatch(matchedApproval, 'replay_envelope', {
          user: 'Belay denied this action because it does not match the approved replay envelope. Re-approve the exact action or run belay explain.',
          agent: 'Belay denied this action because cwd, tool, or payload changed after approval.',
        })
      }
      approved = await consumeApprovedApproval(
        ctx,
        deps,
        kind,
        result.fingerprint,
        result.capabilityRequests ?? [],
      )
    }
  }
  if (approved?.status === 'invalid_bundle') {
    return denyWithPendingApproval({
      reason: 'capability_grant_unavailable',
      grantBundleFailureReason: approved.reason,
      auditFields: (replacement) => ({
        rejectedApprovalId: approved.approval.approvalId,
        rejectedApprovalCorrelationId: approvalCorrelationId(approved.approval.approvalId),
        replacementApprovalCorrelationId: approvalCorrelationId(replacement.approvalId),
      }),
      userMessage: (approvalId) =>
        `Belay denied this action because its approved capability bundle did not exactly match the current request. New approval ID: ${approvalId}. Re-approve the exact action or run belay explain.`,
      agentMessage: `Belay denied this action because the approved capability bundle failed exact validation (${approved.reason}). Wait for the new exact approval, then retry once.`,
    })
  }
  if (approved?.status === 'consumed') {
    if (approved.firstExecution) {
      await recordGateApprovalAsk(stateDir, result.reason, true)
    }
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: 'allow',
      reason: 'approved_once',
      approvalId: approved.approval.approvalId,
      authorizationMode:
        approved.approval.grantBundleVersion === 1 ? 'exact_bundle' : 'legacy_approval',
      wouldBlock: false,
      permission: 'allow',
    })
    return classifyResultToGateVerdict({
      result: { ...result, verdict: 'allow', reason: 'approved_once' },
      mode: ctx.config.mode,
      permission: 'allow',
      wouldBlock: false,
      approvalId: approved.approval.approvalId,
    })
  }

  if (result.verdict === 'allow' || result.verdict === 'allow_flagged') {
    const grantConsumed = await consumeCapabilityGrantIfUsed(ctx, deps, result)
    if (!grantConsumed) {
      await deps.appendAudit(ctx, {
        ...gateBase,
        verdict: 'deny_pending_approval',
        reason: 'capability_grant_unavailable',
        wouldBlock: true,
        permission: 'deny',
      })
      return classifyResultToGateVerdict({
        result: {
          ...result,
          verdict: 'deny_pending_approval',
          reason: 'capability_grant_unavailable',
        },
        mode: ctx.config.mode,
        permission: 'deny',
        wouldBlock: true,
        user_message:
          'Belay denied this action because the capability grant could not be consumed. Re-approve or run belay explain.',
        agent_message:
          'Belay denied this action because the capability grant was missing, expired, or already used.',
      })
    }
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

  if (isJudgeInfrastructureFailure(result)) {
    const fallbackReason = extractJudgeFallbackReason(result)
    const providerId = inferProviderIdFromFallbackReason(
      fallbackReason,
      String(ctx.config.judge.providerId ?? 'cursor'),
    )
    const denyMessages = formatJudgeInfrastructureDenyMessage({
      providerId,
      fallbackReason,
      command: result.normalizedCommand ?? result.summary,
    })
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: result.verdict,
      reason: 'judge_transport_unavailable',
      judgeFallbackReason: fallbackReason,
      wouldBlock: true,
      permission: 'deny',
    })
    return classifyResultToGateVerdict({
      result: {
        ...result,
        verdict: 'deny_pending_approval',
        reason: 'judge_transport_unavailable',
      },
      mode: ctx.config.mode,
      permission: 'deny',
      wouldBlock: true,
      user_message: denyMessages.user_message,
      agent_message: denyMessages.agent_message,
    })
  }

  if (result.reason === FILE_CHECKPOINT_ISOLATION_UNAVAILABLE) {
    const userMessage =
      'Belay cannot run file_checkpoint because attested workspace isolation is unavailable. Run `belay session start`, then retry.'
    const agentMessage =
      'Belay denied this action because file_checkpoint lacks a fresh matching workspace-isolation attestation. Ask the operator to run `belay session start`, then retry the exact action.'
    await deps.appendAudit(ctx, {
      ...gateBase,
      verdict: result.verdict,
      reason: result.reason,
      wouldBlock: true,
      permission: 'deny',
    })
    return classifyResultToGateVerdict({
      result,
      mode: ctx.config.mode,
      permission: 'deny',
      wouldBlock: true,
      user_message: userMessage,
      agent_message: agentMessage,
    })
  }

  return denyWithPendingApproval()
}

export async function processApprovalPrompt(
  ctx: GateRuntimeContext,
  deps: GateRuntimeDeps,
  prompt: string,
): Promise<ApprovalPromptResult> {
  const approvalId = approvalCommandMatch(prompt, ctx.config.tokenPrefix)
  if (!approvalId) {
    return { continue: true }
  }
  const hasFollowupInstruction =
    prompt.split(/\r?\n/).filter((line) => line.trim().length > 0).length > 1

  const adapter = adapterIdFromContext(ctx)

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
    adapter,
    store: gateApprovalStoreFromDeps({
      loadApprovals: (fileName) => deps.loadApprovals(ctx, fileName),
      writeApprovals: (filePath, state) => deps.writeApprovals(filePath, state),
    }),
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

  const replay = recorded.approval ? buildReplayHint(ctx.config, recorded.approval, adapter) : null

  const shouldReplayApprovedShell =
    replay?.kind === 'shell' &&
    replay.autoReplay === true &&
    Boolean(recorded.approval?.input) &&
    (!process.env.VITEST || process.env.BELAY_TEST_APPROVAL_REPLAY === '1')

  if (shouldReplayApprovedShell && recorded.approval) {
    const approvalStore = gateApprovalStoreFromDeps({
      loadApprovals: (fileName) => deps.loadApprovals(ctx, fileName),
      writeApprovals: (filePath, state) => deps.writeApprovals(filePath, state),
    })
    let claimed: ApprovalRecord | null
    try {
      claimed = await claimApprovedForReplay({ approvalId, store: approvalStore })
    } catch {
      return {
        continue: false,
        user_message:
          `Belay approval ${approvalId} could not be claimed for one-step replay. ` +
          'The shell action was not started.',
      }
    }
    if (!claimed) {
      return {
        continue: false,
        user_message: `Belay approval ${approvalId} could not be claimed for one-step replay.`,
      }
    }
    let replayResult: Awaited<ReturnType<GateRuntimeDeps['replayApprovedShell']>>
    try {
      replayResult = await deps.replayApprovedShell(
        ctx,
        claimed.input ?? '',
        claimed.cwd ?? ctx.repoRoot,
        getExecutionLeaseMs(ctx.config),
      )
    } catch (error) {
      const cleanupUnconfirmed = isBoundaryCleanupError(error)
      const auditRecorded = await appendReplayAuditSafely(ctx, deps, {
        event: 'approval',
        kind: 'approval',
        verdict: 'allow',
        approvalId,
        reason: cleanupUnconfirmed
          ? 'approval_replay_cleanup_unconfirmed'
          : 'approval_replay_error',
        summary: recorded.approval.input ?? recorded.approval.summary ?? prompt,
      })
      if (cleanupUnconfirmed) {
        const resourceId = safeBoundaryCleanupResourceId(error)
        return {
          continue: false,
          user_message:
            `Belay approval recorded for ${approvalId}. The one-step shell replay started, but cleanup could not be confirmed; the container may still be running.` +
            (resourceId ? ` Container: ${resourceId}.` : '') +
            ' Inspect Docker and remove the container manually if it is still present. ' +
            'The one-shot approval was consumed and was not re-armed.' +
            (auditRecorded ? '' : REPLAY_AUDIT_FAILURE_NOTE),
        }
      }
      return {
        continue: false,
        user_message:
          `Belay approval recorded for ${approvalId}, but one-step shell replay could not start. ` +
          'The one-shot approval was consumed before replay and was not re-armed.' +
          (auditRecorded ? '' : REPLAY_AUDIT_FAILURE_NOTE),
      }
    }
    if (replayResult.exitCode === 0 && !replayResult.timedOut) {
      const auditRecorded = await appendReplayAuditSafely(ctx, deps, {
        event: 'approval',
        kind: 'approval',
        verdict: 'allow',
        approvalId,
        reason: 'approval_replay_succeeded',
        summary: recorded.approval.input ?? recorded.approval.summary ?? prompt,
      })
      return {
        continue: true,
        user_message:
          `Belay approval recorded for ${approvalId}. One-step shell replay succeeded; no manual retry required.` +
          (auditRecorded ? '' : REPLAY_AUDIT_FAILURE_NOTE),
      }
    }
    const auditRecorded = await appendReplayAuditSafely(ctx, deps, {
      event: 'approval',
      kind: 'approval',
      verdict: 'allow',
      approvalId,
      reason: 'approval_replay_failed',
      summary: recorded.approval.input ?? recorded.approval.summary ?? prompt,
    })
    const failureSummary = replayResult.timedOut
      ? ' One-step shell replay timed out.'
      : ` One-step shell replay failed (exit ${replayResult.exitCode}).`
    return {
      continue: false,
      user_message:
        `Belay approval recorded for ${approvalId}.${failureSummary} ` +
        'The one-shot approval was consumed before replay and was not re-armed.' +
        (auditRecorded ? '' : REPLAY_AUDIT_FAILURE_NOTE),
    }
  }

  return {
    continue: replay !== null || hasFollowupInstruction,
    user_message: recorded.message,
    ...(replay ? { replay } : {}),
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

export function gateVerdictToClaudeUserPromptResponse(
  verdict: ApprovalPromptResult,
): Record<string, unknown> {
  if (verdict.continue) {
    return verdict.user_message
      ? {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: verdict.user_message,
          },
        }
      : {}
  }
  return {
    decision: 'block',
    reason: verdict.user_message,
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
export function gateVerdictToCodexUserPromptResponse(
  verdict: ApprovalPromptResult,
): Record<string, unknown> {
  if (verdict.continue) {
    return verdict.user_message
      ? {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: verdict.user_message,
          },
        }
      : {}
  }
  return {
    decision: 'block',
    reason: verdict.user_message,
    ...(verdict.replay ? { replay: verdict.replay } : {}),
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
