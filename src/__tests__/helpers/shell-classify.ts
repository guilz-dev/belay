import { isCapabilityBrokerDemotionActive } from '../../core/capability/broker.js'
import { type BelayConfigV3, mergeConfig } from '../../core/config.js'
import { GATE_CONTRACT_VERSION } from '../../core/gate-contract.js'
import { classifyGatedAction } from '../../core/gate-engine.js'
import type { ClassifierOptions } from '../../core/types.js'
import { classifyShell } from '../../core/verdict/adapter.js'
import { createDeterministicJudgeStub } from '../../core/verdict/judge.js'

export function shellTestConfig(overrides: Record<string, unknown> = {}): BelayConfigV3 {
  return mergeConfig(overrides)
}

export async function classifyShellCore(
  command: string,
  cwd: string,
  repoRoot: string,
  options: ClassifierOptions = {},
  config?: BelayConfigV3,
) {
  const resolvedConfig =
    config ??
    shellTestConfig({
      policy: {
        unknownLocalEffect: options.unknownLocalEffect ?? 'deny',
        unparseableShell: options.unparseableShell ?? 'deny',
      },
    })
  return classifyShell(command, cwd, repoRoot, resolvedConfig, {
    ...options,
    tier1Judge: options.tier1Judge ?? createDeterministicJudgeStub(),
  })
}

export async function classifyShellGated(
  command: string,
  cwd: string,
  repoRoot: string,
  config: BelayConfigV3,
  options: ClassifierOptions = {},
) {
  const brokerFsScope = options.brokerFsScope ?? isCapabilityBrokerDemotionActive(config)
  return classifyGatedAction(
    {
      contractVersion: GATE_CONTRACT_VERSION,
      kind: 'shell',
      repoRoot,
      cwd,
      command,
    },
    config,
    {
      ...options,
      brokerFsScope,
      tier1Judge: options.tier1Judge ?? createDeterministicJudgeStub(),
    },
  )
}
