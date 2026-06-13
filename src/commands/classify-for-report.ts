import path from 'node:path'

import { getAdapter } from '../adapters/registry.js'
import { repoShellClassifierOptions } from '../adapters/shared/gate-runtime.js'
import { detectAdapterName, loadConfigFile } from '../config-io.js'
import { isCapabilityBrokerDemotionActive } from '../core/capability/broker.js'
import { classifySubagent, classifyToolUse } from '../core/index.js'
import { isTransactionalEligible } from '../core/transactional/index.js'
import type { ClassifyResult } from '../core/types.js'
import { classifyShell } from '../core/v2/adapter.js'
import { egressStatus } from '../services/egress-service.js'
import { sandboxStatus } from '../services/sandbox-service.js'
import type { ClassifyForReportResult, ExplainKind } from '../types.js'

export async function classifyForReport(params: {
  targetDir?: string
  cwd?: string
  kind?: ExplainKind
  command?: string
  toolName?: string
  payload?: Record<string, unknown>
}): Promise<ClassifyForReportResult> {
  const repoRoot = path.resolve(params.targetDir ?? process.cwd())
  const cwd = params.cwd ? path.resolve(params.cwd) : repoRoot
  const config = await loadConfigFile(repoRoot)
  const egress = await egressStatus({ targetDir: repoRoot })
  const sandbox = await sandboxStatus({ targetDir: repoRoot })
  const adapter = getAdapter(config.adapter ?? detectAdapterName(repoRoot))
  const classifierOptions = repoShellClassifierOptions(config, repoRoot, adapter.layout, {
    brokerFsScope: isCapabilityBrokerDemotionActive(config),
  })

  const kind = params.kind ?? 'shell'
  let input = params.command ?? ''
  let result: ClassifyResult

  if (kind === 'shell') {
    if (!params.command) {
      throw new Error('classify-for-report requires a command for shell classification.')
    }
    result = await classifyShell(params.command, cwd, repoRoot, config, classifierOptions)
    input = params.command
  } else if (kind === 'subagent') {
    const payload = params.payload ?? {
      tool_name: 'Task',
      tool_input: { description: params.command ?? '' },
    }
    if (!params.command && !params.payload) {
      throw new Error(
        'classify-for-report requires command or payload for subagent classification.',
      )
    }
    result = classifySubagent(payload, repoRoot, classifierOptions)
    input = params.command ?? JSON.stringify(payload)
  } else if (kind === 'tool') {
    const payload =
      params.payload ??
      ({
        tool_name: params.toolName ?? 'Shell',
        tool_input:
          params.toolName === 'Shell'
            ? { command: params.command ?? '' }
            : { path: params.command ?? '' },
      } as Record<string, unknown>)
    if (!params.command && !params.payload) {
      throw new Error('classify-for-report requires command or payload for tool classification.')
    }
    result = await classifyToolUse(payload, repoRoot, cwd, config, classifierOptions)
    input = params.command ?? JSON.stringify(payload)
  } else {
    throw new Error(`Unknown classify kind: ${kind}`)
  }

  const transactionalEligible = kind === 'shell' && isTransactionalEligible(config, 'shell', result)

  const permission =
    result.v2?.would ??
    (result.verdict === 'allow' || result.verdict === 'allow_flagged' ? 'allow' : 'ask')
  const tier =
    result.reason.startsWith('tier0_') || result.reason === 'external_effect'
      ? 'Tier0'
      : result.v2?.confidence === 'llm' || result.reason === 'unknown_local_effect'
        ? 'Tier1'
        : 'deterministic'

  return {
    repoRoot,
    kind,
    input,
    cwd,
    config,
    policy: config.policy,
    overrides: config.overrides,
    egress: config.egress,
    egressProxyRunning: egress.running && !egress.foreignProxy && !egress.repoRootMismatch,
    sandbox: config.sandbox,
    sandboxBrokerActive: classifierOptions.brokerFsScope === true,
    l1FullActive: sandbox.l1FullActive,
    transactionalEligible,
    permission,
    tier,
    result,
  }
}
