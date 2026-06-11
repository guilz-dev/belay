import { classifyShell } from './classify-shell.js'
import { classifySubagent } from './classify-subagent.js'
import { classifyToolUse } from './classify-tool.js'
import type { BelayConfigV3 } from './config.js'
import { classifierOptionsFromConfig, DEFAULT_CONFIDENCE_THRESHOLDS } from './config.js'
import type { GatedAction, GatedActionKind } from './gate-contract.js'
import { GATE_CONTRACT_VERSION } from './gate-contract.js'
import { mergeAgentAssessment, verdictFromConfidence } from './judgment.js'
import { maybeAssistAssessment } from './model-assist.js'
import type { Assessment, ClassifierOptions, ClassifyResult } from './types.js'

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

export function classifyGatedAction(
  action: GatedAction,
  config: BelayConfigV3,
  extraOptions: ClassifierOptions = {},
): ClassifyResult {
  const options = { ...classifierOptionsFromConfig(config), ...extraOptions }

  if (action.kind === 'shell') {
    const command = action.command ?? shellCommandFromPayload(action.payload ?? {})
    if (!command) {
      throw new GateNormalizationError('Shell gated action requires a command.')
    }
    const result = classifyShell(command, action.cwd, action.repoRoot, options)
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

  return classifyToolUse(action.payload ?? {}, action.repoRoot, action.cwd, options)
}

function applyModelAssistToResult(
  result: ClassifyResult,
  assistedAssessment: Assessment,
  options: ClassifierOptions,
): ClassifyResult {
  if (result.reason !== 'unknown_local_effect' && result.reason !== 'unparseable_shell') {
    return { ...result, assessment: assistedAssessment }
  }

  const thresholds = options.confidenceThresholds ?? DEFAULT_CONFIDENCE_THRESHOLDS
  const unknownLocalEffect = options.unknownLocalEffect ?? 'allow_flagged'
  const unparseableShell = options.unparseableShell ?? 'allow_flagged'

  if (result.reason === 'unparseable_shell') {
    return {
      ...result,
      assessment: assistedAssessment,
      verdict: unparseableShell === 'deny' ? 'deny_pending_approval' : 'allow_flagged',
    }
  }

  return {
    ...result,
    assessment: assistedAssessment,
    verdict: verdictFromConfidence(assistedAssessment, thresholds, unknownLocalEffect),
  }
}

export async function classifyGatedActionAsync(
  action: GatedAction,
  config: BelayConfigV3,
  extraOptions: ClassifierOptions = {},
): Promise<ClassifyResult> {
  const options = { ...classifierOptionsFromConfig(config), ...extraOptions }
  const result = classifyGatedAction(action, config, extraOptions)

  if (action.kind !== 'shell' || !config.policy.modelAssist.enabled) {
    return result
  }

  const command = action.command ?? shellCommandFromPayload(action.payload ?? {})
  if (!command) {
    return result
  }

  const assisted = await maybeAssistAssessment(
    {
      command,
      attributes: {
        commandKey: '',
        normalizedCommand: command,
        cwdRelative: '',
        flags: [],
        targetScope: 'repo',
        redirectKind: 'none',
        signals: result.assessment.signals,
        isUnparseable: result.reason === 'unparseable_shell',
        isDynamicEval: false,
        hasPipeToShell: false,
        hitsProtectedArtifact: false,
        hitsOutsideRepo: false,
        isCustomAllow: false,
        isCustomExternal: false,
        isReadOnlyKey: false,
        isFlaggedKey: false,
        isExternalKey: false,
        hasCredentialHeader: false,
        findDangerous: false,
      },
      heuristicAssessment: result.assessment,
    },
    config.policy.modelAssist,
  )

  if (!assisted.assisted) {
    return result
  }

  return applyModelAssistToResult(result, assisted.assessment, options)
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
