import { allPathsAllowlisted } from './capability/allowlist.js'
import {
  collectOutsideRepoPaths,
  collectOutsideRepoPathsFromToolPayload,
} from './capability/paths.js'
import { classifySubagent } from './classify-subagent.js'
import { classifyToolUse } from './classify-tool.js'
import type { BelayConfigV3 } from './config.js'
import { classifierOptionsFromConfig } from './config.js'
import type { GatedAction, GatedActionKind } from './gate-contract.js'
import { GATE_CONTRACT_VERSION } from './gate-contract.js'
import { mergeAgentAssessment } from './judgment.js'
import type { Assessment, ClassifierOptions, ClassifyResult } from './types.js'
import { classifyShell } from './verdict/adapter.js'

export class GateNormalizationError extends Error {
  readonly reason = 'normalization_failed'

  constructor(message: string) {
    super(message)
    this.name = 'GateNormalizationError'
  }
}

function parseAssessment(value: unknown): Assessment | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    (record.reversibility === 'reversible' ||
      record.reversibility === 'recoverable_with_cost' ||
      record.reversibility === 'irreversible') &&
    typeof record.external === 'boolean' &&
    typeof record.blastRadius === 'string' &&
    typeof record.confidence === 'number' &&
    Array.isArray(record.signals) &&
    record.signals.every((signal) => typeof signal === 'string')
  ) {
    return {
      reversibility: record.reversibility,
      external: record.external,
      blastRadius: record.blastRadius,
      confidence: record.confidence,
      signals: record.signals,
    }
  }
  return undefined
}

export function extractAgentAssessment(payload?: Record<string, unknown>): Assessment | undefined {
  if (!payload) {
    return undefined
  }

  for (const key of ['agentAssessment', 'assessment'] as const) {
    const parsed = parseAssessment(payload[key])
    if (parsed) {
      return parsed
    }
  }

  const toolInput = payload.tool_input
  if (toolInput && typeof toolInput === 'object') {
    return extractAgentAssessment(toolInput as Record<string, unknown>)
  }

  return undefined
}

function shellCommandFromPayload(payload: Record<string, unknown>): string {
  const direct = payload.command
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim()
  }
  const toolInput = payload.tool_input
  if (toolInput && typeof toolInput === 'object') {
    const command = (toolInput as Record<string, unknown>).command
    if (typeof command === 'string' && command.trim()) {
      return command.trim()
    }
  }
  return ''
}

export function normalizeGatedAction(params: {
  kind: GatedActionKind
  repoRoot: string
  cwd: string
  command?: string
  payload?: Record<string, unknown>
  toolName?: string
  agentAssessment?: GatedAction['agentAssessment']
}): GatedAction {
  const { kind, repoRoot, cwd, payload, toolName, agentAssessment } = params
  let command = params.command?.trim() ?? ''

  if (kind === 'shell' && !command && payload) {
    command = shellCommandFromPayload(payload)
  }

  if (kind === 'shell' && !command) {
    throw new GateNormalizationError('Shell gated action requires a command.')
  }

  if (kind === 'tool' && !payload) {
    throw new GateNormalizationError('Tool gated action requires a payload.')
  }

  if (kind === 'subagent' && !payload) {
    throw new GateNormalizationError('Subagent gated action requires a payload.')
  }

  return {
    contractVersion: GATE_CONTRACT_VERSION,
    kind,
    repoRoot,
    cwd,
    command: command || undefined,
    payload,
    toolName,
    agentAssessment,
  }
}

function applySandboxFsScopeBoundary(
  outsideRepoPaths: string[],
  result: ClassifyResult,
  options: ClassifierOptions,
  hints: { redirect?: boolean } = {},
): ClassifyResult {
  if (!options.brokerFsScope) {
    return result
  }
  if (outsideRepoPaths.length === 0) {
    return result
  }
  if (options.fsScopeAllowlist && allPathsAllowlisted(outsideRepoPaths, options.fsScopeAllowlist)) {
    return result
  }
  if (result.verdict === 'deny_pending_approval') {
    return result
  }
  const redirect =
    hints.redirect === true ||
    result.reason === 'read_only' ||
    result.assessment.signals.includes('read_only') ||
    result.reason === 'outside_repo_redirect'
  return {
    ...result,
    verdict: 'deny_pending_approval',
    reason: redirect ? 'outside_repo_redirect' : 'outside_repo_mutation',
    assessment: {
      ...result.assessment,
      external: true,
      reversibility: 'irreversible',
      signals: [...result.assessment.signals, 'sandbox_boundary_expected'],
    },
  }
}

function applyFsScopePeripheralPolicy(
  outsideRepoPaths: string[],
  result: ClassifyResult,
  options: ClassifierOptions,
): ClassifyResult {
  if (!options.brokerFsScope) {
    return result
  }
  if (outsideRepoPaths.length === 0) {
    return result
  }
  if (options.fsScopeAllowlist && allPathsAllowlisted(outsideRepoPaths, options.fsScopeAllowlist)) {
    if (
      result.verdict === 'deny_pending_approval' &&
      (result.reason === 'outside_repo_mutation' ||
        result.reason === 'outside_repo_redirect' ||
        result.reason === 'repo_outside_mutation' ||
        result.axes?.location === 'repo_outside')
    ) {
      return {
        ...result,
        verdict: 'allow_flagged',
        reason: 'capability_fs_hint',
        assessment: {
          ...result.assessment,
          signals: [
            ...result.assessment.signals,
            'capability_fs_hint',
            'sandbox_boundary_expected',
          ],
        },
      }
    }
    if (result.verdict === 'allow' || result.verdict === 'allow_flagged') {
      return {
        ...result,
        verdict: 'allow_flagged',
        reason: 'capability_fs_hint',
        assessment: {
          ...result.assessment,
          signals: [
            ...result.assessment.signals,
            'capability_fs_hint',
            'sandbox_boundary_expected',
          ],
        },
      }
    }
  }
  return result
}

function applySandboxOutsideBoundary(
  command: string,
  action: GatedAction,
  result: ClassifyResult,
  options: ClassifierOptions,
): ClassifyResult {
  const outsideRepoPaths = collectOutsideRepoPaths(
    command,
    action.cwd,
    action.repoRoot,
    options.trustedWorkspaceRoots,
  )
  return applySandboxFsScopeBoundary(outsideRepoPaths, result, options, {
    redirect: command.includes('>'),
  })
}

function applyShellPeripheralPolicy(
  command: string,
  action: GatedAction,
  result: ClassifyResult,
  options: ClassifierOptions,
): ClassifyResult {
  const outsideRepoPaths = collectOutsideRepoPaths(
    command,
    action.cwd,
    action.repoRoot,
    options.trustedWorkspaceRoots,
  )
  return applyFsScopePeripheralPolicy(outsideRepoPaths, result, options)
}

function outsideRepoPathsForToolAction(action: GatedAction, options: ClassifierOptions): string[] {
  const payload = action.payload ?? {}
  const paths = new Set(
    collectOutsideRepoPathsFromToolPayload(
      payload,
      action.cwd,
      action.repoRoot,
      options.trustedWorkspaceRoots,
    ),
  )
  const command = shellCommandFromPayload(payload)
  if (command) {
    for (const resolved of collectOutsideRepoPaths(
      command,
      action.cwd,
      action.repoRoot,
      options.trustedWorkspaceRoots,
    )) {
      paths.add(resolved)
    }
  }
  return [...paths]
}

function applyToolSandboxPolicies(
  action: GatedAction,
  result: ClassifyResult,
  options: ClassifierOptions,
): ClassifyResult {
  const outsideRepoPaths = outsideRepoPathsForToolAction(action, options)
  const command = shellCommandFromPayload(action.payload ?? {})
  let next = applySandboxFsScopeBoundary(outsideRepoPaths, result, options, {
    redirect: command.includes('>'),
  })
  next = applyFsScopePeripheralPolicy(outsideRepoPaths, next, options)
  return next
}

export async function classifyGatedAction(
  action: GatedAction,
  config: BelayConfigV3,
  extraOptions: ClassifierOptions = {},
): Promise<ClassifyResult> {
  const options = { ...classifierOptionsFromConfig(config), ...extraOptions }

  if (action.kind === 'shell') {
    const command = action.command ?? shellCommandFromPayload(action.payload ?? {})
    if (!command) {
      throw new GateNormalizationError('Shell gated action requires a command.')
    }
    let result = await classifyShell(command, action.cwd, action.repoRoot, config, options)
    result = applySandboxOutsideBoundary(command, action, result, options)
    result = applyShellPeripheralPolicy(command, action, result, options)
    if (!action.agentAssessment) {
      return result
    }
    const merged = mergeAgentAssessment(result.assessment, action.agentAssessment)
    if (!merged.mismatch) {
      return { ...result, assessment: merged.assessment }
    }
    return {
      ...result,
      verdict: 'deny_pending_approval',
      reason: 'agent_assessment_mismatch',
      assessment: merged.assessment,
    }
  }

  if (action.kind === 'subagent') {
    return classifySubagent(action.payload ?? {}, action.repoRoot, options)
  }

  let result = await classifyToolUse(
    action.payload ?? {},
    action.repoRoot,
    action.cwd,
    config,
    options,
  )
  result = applyToolSandboxPolicies(action, result, options)
  if (!action.agentAssessment) {
    return result
  }
  const merged = mergeAgentAssessment(result.assessment, action.agentAssessment)
  if (!merged.mismatch) {
    return { ...result, assessment: merged.assessment }
  }
  return {
    ...result,
    verdict: 'deny_pending_approval',
    reason: 'agent_assessment_mismatch',
    assessment: merged.assessment,
  }
}

export async function classifyGatedActionAsync(
  action: GatedAction,
  config: BelayConfigV3,
  extraOptions: ClassifierOptions = {},
): Promise<ClassifyResult> {
  return classifyGatedAction(action, config, extraOptions)
}

export function gateEnabledForAction(config: BelayConfigV3, action: GatedAction): boolean {
  if (action.kind === 'shell') {
    return config.gates.shell
  }
  if (action.kind === 'subagent') {
    return config.gates.subagent
  }

  const toolName = action.toolName ?? String(action.payload?.tool_name ?? '')
  if (toolName === 'Shell') {
    return config.gates.toolShell
  }
  if (toolName === 'Write' || toolName === 'StrReplace' || toolName === 'Delete') {
    return config.gates.fileMutation
  }
  if (toolName === 'Task') {
    return config.gates.subagent
  }
  return true
}
