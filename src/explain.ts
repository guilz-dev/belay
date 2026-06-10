import path from 'node:path'

import { loadConfigFile } from './config-io.js'
import {
  classifierOptionsFromConfig,
  classifyShell,
  classifySubagent,
  classifyToolUse,
} from './core/index.js'
import type { ClassifyResult } from './core/types.js'
import type { ExplainOptions, ExplainReport } from './types.js'

function classifyExplainTarget(
  options: ExplainOptions,
  repoRoot: string,
  cwd: string,
  classifierOptions: ReturnType<typeof classifierOptionsFromConfig>,
): { kind: string; input: string; result: ClassifyResult } {
  const kind = options.kind ?? 'shell'

  if (kind === 'shell') {
    if (!options.command) {
      throw new Error('explain requires a command for shell classification.')
    }
    return {
      kind: 'shell',
      input: options.command,
      result: classifyShell(options.command, cwd, repoRoot, classifierOptions),
    }
  }

  if (kind === 'subagent') {
    const payload = options.payload ?? {
      tool_name: 'Task',
      tool_input: {
        description: options.command ?? '',
      },
    }
    if (!options.command && !options.payload) {
      throw new Error('explain requires --command or --payload-json for subagent classification.')
    }
    return {
      kind: 'subagent',
      input: options.command ?? JSON.stringify(payload),
      result: classifySubagent(payload, repoRoot, classifierOptions),
    }
  }

  if (kind === 'tool') {
    const payload =
      options.payload ??
      ({
        tool_name: options.toolName ?? 'Shell',
        tool_input:
          options.toolName === 'Shell'
            ? { command: options.command ?? '' }
            : { path: options.command ?? '' },
      } as Record<string, unknown>)
    if (!options.command && !options.payload) {
      throw new Error('explain requires --command or --payload-json for tool classification.')
    }
    return {
      kind: 'tool',
      input: options.command ?? JSON.stringify(payload),
      result: classifyToolUse(payload, repoRoot, cwd, classifierOptions),
    }
  }

  throw new Error(`Unknown explain kind: ${kind}`)
}

export async function explainCommand(options: ExplainOptions): Promise<ExplainReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const cwd = options.cwd ? path.resolve(options.cwd) : repoRoot
  const config = await loadConfigFile(repoRoot)
  const classifierOptions = classifierOptionsFromConfig(config)
  const classified = classifyExplainTarget(options, repoRoot, cwd, classifierOptions)

  return {
    repoRoot,
    kind: classified.kind,
    command: classified.input,
    cwd,
    policy: config.policy,
    overrides: config.overrides,
    result: classified.result,
  }
}

export function formatExplainReport(report: ExplainReport): string {
  const { result } = report
  const lines = [
    `agent-belay explain for ${report.repoRoot}`,
    `Kind: ${report.kind}`,
    `Input: ${report.command}`,
    `CWD: ${report.cwd}`,
    `Policy unknownLocalEffect: ${report.policy.unknownLocalEffect}`,
    `Overrides allow: ${report.overrides.allow.join(', ') || '(none)'}`,
    `Overrides external: ${report.overrides.external.join(', ') || '(none)'}`,
    '',
    `Verdict: ${result.verdict}`,
    `Reason: ${result.reason}`,
    `Fingerprint: ${result.fingerprint}`,
    '',
    'Assessment:',
    `  reversibility: ${result.assessment.reversibility}`,
    `  external: ${result.assessment.external}`,
    `  blastRadius: ${result.assessment.blastRadius}`,
    `  confidence: ${result.assessment.confidence}`,
    `  signals: ${result.assessment.signals.join(', ') || '(none)'}`,
  ]
  return `${lines.join('\n')}\n`
}
