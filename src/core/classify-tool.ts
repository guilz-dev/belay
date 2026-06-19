import path from 'node:path'
import type { BelayConfigV3 } from './config.js'
import { canonicalStringify, toolFingerprint } from './fingerprint.js'
import { matchesSensitivePath } from './glob.js'
import { pathWithinRoot, resolveWorkspaceRootMatch } from './path-utils.js'
import { scrubValue } from './scrub.js'
import type { ClassifierOptions, ClassifyResult } from './types.js'
import { classifyShell, resolveClassifierTrustedCwd } from './verdict/adapter.js'
import { mutationPrescanRequiresAsk, tier1RequiresAsk } from './verdict/judge.js'
import { createJudgeFromConfig } from './verdict/judge-factory.js'
import type { Tier1Judge } from './verdict/types.js'

const DEFAULT_SENSITIVE_PATHS = ['.env', '.env.*', '**/credentials/**']
const FILE_WRITE_TOOL_NAMES = new Set(['write'])
const FILE_EDIT_TOOL_NAMES = new Set([
  'edit',
  'multiedit',
  'multi_edit',
  'patch',
  'strreplace',
  'str_replace',
])
const FILE_DELETE_TOOL_NAMES = new Set(['delete'])
const APPLY_PATCH_TOOL_NAMES = new Set(['apply_patch', 'applypatch'])

function scrubPayload(value: unknown, options: ClassifierOptions): unknown {
  return scrubValue(value, options.scrubOptions)
}

function extractFilePath(payload: Record<string, unknown>): string | null {
  const toolInput = payload.tool_input
  if (!toolInput || typeof toolInput !== 'object') {
    return null
  }
  const input = toolInput as Record<string, unknown>
  for (const key of ['path', 'file_path', 'target_file', 'filePath']) {
    if (typeof input[key] === 'string') {
      return input[key]
    }
  }
  return null
}

function extractShellCommand(payload: Record<string, unknown>): string | null {
  const toolInput = payload.tool_input
  if (!toolInput || typeof toolInput !== 'object') {
    return null
  }
  const input = toolInput as Record<string, unknown>
  if (typeof input.command === 'string') {
    return input.command
  }
  return null
}

function extractPatch(payload: Record<string, unknown>): string | null {
  const toolInput = payload.tool_input
  if (!toolInput || typeof toolInput !== 'object') {
    return null
  }
  const input = toolInput as Record<string, unknown>
  for (const key of ['patch', 'input', 'text']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return input[key] as string
    }
  }
  return null
}

function applyPatchTargets(patch: string): Array<{ path: string; delete: boolean }> {
  const targets: Array<{ path: string; delete: boolean }> = []
  for (const line of patch.split('\n')) {
    const match = line.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/)
    if (match?.[1] && match[2]) {
      targets.push({ path: match[2], delete: match[1] === 'Delete' })
      continue
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/)
    if (moveMatch?.[1]) {
      targets.push({ path: moveMatch[1], delete: false })
    }
  }
  return targets
}

function normalizedToolName(toolName: string): string {
  return toolName.trim().toLowerCase()
}

function resolveFileTier1Judge(
  config: BelayConfigV3,
  options: ClassifierOptions,
  repoRoot: string,
): Tier1Judge {
  return options.tier1Judge ?? createJudgeFromConfig(config, { repoRoot })
}

async function classifyFileMutationWithTier1(params: {
  toolName: string
  toolKind: string
  filePath: string
  resolvedPath: string
  repoRoot: string
  cwd: string
  config: BelayConfigV3
  options: ClassifierOptions
  signals: string[]
  isDelete: boolean
  locationLabel: 'outside_repo' | 'sensitive_path'
}): Promise<ClassifyResult> {
  const judge = resolveFileTier1Judge(params.config, params.options, params.repoRoot)
  const trustedCwd = resolveClassifierTrustedCwd(params.cwd, params.options)
  const prescan = mutationPrescanRequiresAsk({
    targets: [params.filePath],
    cwd: params.cwd,
    repoRoot: params.repoRoot,
    trustedCwd,
    trustedWorkspaceRoots: params.options.trustedWorkspaceRoots,
    sensitivePaths: params.options.sensitivePaths ?? params.config.classifier.sensitivePaths,
  })
  if (prescan) {
    return {
      verdict: 'deny_pending_approval',
      reason: 'tier1_catastrophic',
      summary: params.filePath,
      fingerprint: toolFingerprint(params.toolName, { path: params.filePath }, params.repoRoot),
      assessment: {
        reversibility: 'irreversible',
        external: params.locationLabel === 'outside_repo',
        blastRadius:
          params.locationLabel === 'outside_repo'
            ? 'outside the repository'
            : 'sensitive repository file',
        confidence: 0.95,
        signals: [...params.signals, 'tier1_catastrophic', prescan.reason],
      },
    }
  }
  const tier1Text = `file_mutation: ${params.toolKind} path=${params.resolvedPath} location=${params.locationLabel}`
  const tier1 = await judge.evaluate({
    text: tier1Text,
    context: { cwd: params.cwd, repoRoot: params.repoRoot },
  })

  const fingerprint = toolFingerprint(params.toolName, { path: params.filePath }, params.repoRoot)

  if (tier1RequiresAsk(tier1)) {
    return {
      verdict: 'deny_pending_approval',
      reason: 'tier1_catastrophic',
      summary: params.filePath,
      fingerprint,
      assessment: {
        reversibility: 'irreversible',
        external: params.locationLabel === 'outside_repo',
        blastRadius:
          params.locationLabel === 'outside_repo'
            ? 'outside the repository'
            : 'sensitive repository file',
        confidence: 0.82,
        signals: [...params.signals, 'tier1_catastrophic', tier1.reason],
      },
    }
  }

  const reason = params.isDelete ? 'file_delete' : 'file_mutation'
  return {
    verdict: 'allow_flagged',
    reason,
    summary: params.filePath,
    fingerprint,
    assessment: {
      reversibility: 'recoverable_with_cost',
      external: params.locationLabel === 'outside_repo',
      blastRadius:
        params.locationLabel === 'outside_repo' ? 'outside the repository' : 'this repository',
      confidence: 0.72,
      signals: [...params.signals, 'tier1_restorable', tier1.reason],
    },
  }
}

export async function classifyToolUse(
  payload: Record<string, unknown>,
  repoRoot: string,
  cwd: string,
  config: BelayConfigV3,
  options: ClassifierOptions = {},
): Promise<ClassifyResult> {
  const toolName = String(payload.tool_name ?? '')
  const toolKind = normalizedToolName(toolName)
  const sensitivePaths = [...DEFAULT_SENSITIVE_PATHS, ...(options.sensitivePaths ?? [])]

  const protectedRoots = [
    ...(options.protectedArtifactRoots ?? []),
    ...(options.controlPlaneDir ? [options.controlPlaneDir] : []),
  ]

  if (toolKind === 'shell') {
    const command = extractShellCommand(payload)
    if (!command) {
      if (options.unknownLocalEffect === 'deny') {
        return {
          verdict: 'deny_pending_approval',
          reason: 'tool_shell_missing_command',
          summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
          fingerprint: toolFingerprint(
            toolName,
            scrubPayload(payload.tool_input ?? {}, options),
            repoRoot,
          ),
          assessment: {
            reversibility: 'irreversible',
            external: false,
            blastRadius: 'tool shell',
            confidence: 0.85,
            signals: ['missing_command'],
          },
        }
      }
      return {
        verdict: 'allow_flagged',
        reason: 'tool_shell_missing_command',
        summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
        fingerprint: toolFingerprint(
          toolName,
          scrubPayload(payload.tool_input ?? {}, options),
          repoRoot,
        ),
        assessment: {
          reversibility: 'recoverable_with_cost',
          external: false,
          blastRadius: 'tool shell',
          confidence: 0.5,
          signals: ['missing_command'],
        },
      }
    }
    const shellResult = await classifyShell(command, cwd, repoRoot, config, options)
    return {
      ...shellResult,
      summary: command,
    }
  }

  if (
    FILE_WRITE_TOOL_NAMES.has(toolKind) ||
    FILE_EDIT_TOOL_NAMES.has(toolKind) ||
    FILE_DELETE_TOOL_NAMES.has(toolKind)
  ) {
    const filePath = extractFilePath(payload)
    if (!filePath) {
      if (options.unknownLocalEffect === 'deny') {
        return {
          verdict: 'deny_pending_approval',
          reason: 'file_mutation_missing_path',
          summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
          fingerprint: toolFingerprint(
            toolName,
            scrubPayload(payload.tool_input ?? {}, options),
            repoRoot,
          ),
          assessment: {
            reversibility: 'irreversible',
            external: false,
            blastRadius: 'file mutation',
            confidence: 0.85,
            signals: ['missing_path'],
          },
        }
      }
      return {
        verdict: 'allow_flagged',
        reason: 'file_mutation_missing_path',
        summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
        fingerprint: toolFingerprint(
          toolName,
          scrubPayload(payload.tool_input ?? {}, options),
          repoRoot,
        ),
        assessment: {
          reversibility: 'recoverable_with_cost',
          external: false,
          blastRadius: 'file mutation',
          confidence: 0.55,
          signals: ['missing_path'],
        },
      }
    }

    const signals: string[] = []
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)

    const hitsProtectedRoot = protectedRoots.some((root) => pathWithinRoot(root, resolvedPath))
    if (hitsProtectedRoot) {
      signals.push('control_plane_path')
      return {
        verdict: 'deny_pending_approval',
        reason: 'control_plane_mutation',
        summary: filePath,
        fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
        assessment: {
          reversibility: 'irreversible',
          external: false,
          blastRadius: 'agent-belay control plane',
          confidence: 0.97,
          signals,
        },
      }
    }

    const workspaceMatch = resolveWorkspaceRootMatch(
      repoRoot,
      options.trustedWorkspaceRoots,
      resolvedPath,
    )
    if (workspaceMatch === null) {
      signals.push('outside_repo_path')
      return classifyFileMutationWithTier1({
        toolName,
        toolKind,
        filePath,
        resolvedPath,
        repoRoot,
        cwd,
        config,
        options,
        signals,
        isDelete: FILE_DELETE_TOOL_NAMES.has(toolKind),
        locationLabel: 'outside_repo',
      })
    }

    if (workspaceMatch.kind === 'trusted') {
      signals.push('trusted_workspace_root')
    }

    const trustedCwd = resolveClassifierTrustedCwd(cwd, options)
    const workspacePrescan = mutationPrescanRequiresAsk({
      targets: [filePath],
      cwd,
      repoRoot,
      trustedCwd,
      trustedWorkspaceRoots: options.trustedWorkspaceRoots,
      sensitivePaths,
    })
    if (workspacePrescan) {
      return classifyFileMutationWithTier1({
        toolName,
        toolKind,
        filePath,
        resolvedPath,
        repoRoot,
        cwd,
        config,
        options,
        signals,
        isDelete: FILE_DELETE_TOOL_NAMES.has(toolKind),
        locationLabel: 'sensitive_path',
      })
    }

    const relativePath = workspaceMatch.relativePath

    if (matchesSensitivePath(relativePath, sensitivePaths)) {
      signals.push('sensitive_path')
      return classifyFileMutationWithTier1({
        toolName,
        toolKind,
        filePath,
        resolvedPath,
        repoRoot,
        cwd,
        config,
        options,
        signals,
        isDelete: FILE_DELETE_TOOL_NAMES.has(toolKind),
        locationLabel: 'sensitive_path',
      })
    }

    if (FILE_DELETE_TOOL_NAMES.has(toolKind)) {
      signals.push('file_delete')
      return {
        verdict: 'allow_flagged',
        reason: 'file_delete',
        summary: filePath,
        fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
        assessment: {
          reversibility: 'recoverable_with_cost',
          external: false,
          blastRadius: 'this repository',
          confidence: 0.7,
          signals,
        },
      }
    }

    signals.push('file_mutation')
    return {
      verdict: 'allow_flagged',
      reason: 'file_mutation',
      summary: filePath,
      fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'this repository',
        confidence: 0.68,
        signals,
      },
    }
  }

  if (APPLY_PATCH_TOOL_NAMES.has(toolKind)) {
    const patch = extractPatch(payload)
    const targets = patch ? applyPatchTargets(patch) : []
    if (targets.length === 0) {
      if (options.unknownLocalEffect === 'deny') {
        return {
          verdict: 'deny_pending_approval',
          reason: 'apply_patch_missing_path',
          summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
          fingerprint: toolFingerprint(
            toolName,
            scrubPayload(payload.tool_input ?? {}, options),
            repoRoot,
          ),
          assessment: {
            reversibility: 'irreversible',
            external: false,
            blastRadius: 'file mutation',
            confidence: 0.85,
            signals: ['missing_path'],
          },
        }
      }
      return {
        verdict: 'allow_flagged',
        reason: 'apply_patch_missing_path',
        summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
        fingerprint: toolFingerprint(
          toolName,
          scrubPayload(payload.tool_input ?? {}, options),
          repoRoot,
        ),
        assessment: {
          reversibility: 'recoverable_with_cost',
          external: false,
          blastRadius: 'file mutation',
          confidence: 0.55,
          signals: ['missing_path'],
        },
      }
    }

    let sawDelete = false
    for (const target of targets) {
      const result = await classifyToolUse(
        {
          tool_name: target.delete ? 'Delete' : 'Write',
          tool_input: { path: target.path },
        },
        repoRoot,
        cwd,
        config,
        options,
      )
      if (result.verdict === 'deny_pending_approval') {
        return result
      }
      sawDelete ||= target.delete
    }

    return {
      verdict: 'allow_flagged',
      reason: sawDelete ? 'file_delete' : 'file_mutation',
      summary: targets.map((target) => target.path).join(', '),
      fingerprint: toolFingerprint(
        toolName,
        scrubPayload(payload.tool_input ?? {}, options),
        repoRoot,
      ),
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'this repository',
        confidence: sawDelete ? 0.7 : 0.68,
        signals: [sawDelete ? 'file_delete' : 'file_mutation', 'apply_patch'],
      },
    }
  }

  return {
    verdict: 'allow',
    reason: 'unclassified_tool',
    summary: canonicalStringify(scrubPayload(payload.tool_input ?? {}, options)),
    fingerprint: toolFingerprint(
      toolName,
      scrubPayload(payload.tool_input ?? {}, options),
      repoRoot,
    ),
    assessment: {
      reversibility: 'reversible',
      external: false,
      blastRadius: 'tool scope',
      confidence: 0.5,
      signals: ['unclassified_tool'],
    },
  }
}
