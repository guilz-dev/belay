import { describe, expect, it } from 'vitest'
import {
  checkGatedActionLimits,
  MAX_SHELL_COMMAND_BYTES,
  MAX_TOOL_PAYLOAD_BYTES,
} from '../../core/capability/limits.js'
import { mergeConfig } from '../../core/config.js'
import { GATE_CONTRACT_VERSION } from '../../core/gate-contract.js'
import { classifyGatedAction, normalizeGatedAction } from '../../core/gate-engine.js'

const config = mergeConfig({})

describe('gated action input limits', () => {
  it('rejects oversized shell commands', async () => {
    const command = 'x'.repeat(MAX_SHELL_COMMAND_BYTES + 1)
    const action = normalizeGatedAction({
      kind: 'shell',
      repoRoot: '/workspace/project',
      cwd: '/workspace/project',
      command,
    })
    const direct = checkGatedActionLimits(action)
    expect(direct?.reason).toBe('input_too_large')
    const viaGate = await classifyGatedAction(action, config)
    expect(viaGate.reason).toBe('input_too_large')
    expect(viaGate.verdict).toBe('deny_pending_approval')
  })

  it('rejects oversized tool payloads', async () => {
    const huge = 'a'.repeat(MAX_TOOL_PAYLOAD_BYTES)
    const action = normalizeGatedAction({
      kind: 'tool',
      repoRoot: '/workspace/project',
      cwd: '/workspace/project',
      payload: {
        tool_name: 'Write',
        tool_input: { path: 'notes.txt', contents: huge },
      },
    })
    const result = await classifyGatedAction(action, config)
    expect(result.reason).toBe('input_too_large')
  })
})

describe('normalize contract', () => {
  it('preserves contract version on limit failures', () => {
    const action = normalizeGatedAction({
      kind: 'shell',
      repoRoot: '/workspace/project',
      cwd: '/workspace/project',
      command: 'ok',
    })
    expect(action.contractVersion).toBe(GATE_CONTRACT_VERSION)
  })
})
