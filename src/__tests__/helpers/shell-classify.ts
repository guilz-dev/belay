import { type BelayConfigV3, mergeConfig } from '../../core/config.js'
import { GATE_CONTRACT_VERSION } from '../../core/gate-contract.js'
import { classifyGatedAction } from '../../core/gate-engine.js'
import type { ClassifierOptions } from '../../core/types.js'
import { classifyShell } from '../../core/v2/adapter.js'

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
  return classifyShell(command, cwd, repoRoot, resolvedConfig, options)
}

export async function classifyShellGated(
  command: string,
  cwd: string,
  repoRoot: string,
  config: BelayConfigV3,
  options: ClassifierOptions = {},
) {
  return classifyGatedAction(
    {
      contractVersion: GATE_CONTRACT_VERSION,
      kind: 'shell',
      repoRoot,
      cwd,
      command,
    },
    config,
    options,
  )
}
