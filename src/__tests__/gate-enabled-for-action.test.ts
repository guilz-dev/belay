import { describe, expect, it } from 'vitest'

import { mergeConfig } from '../core/config.js'
import { GATE_CONTRACT_VERSION, type GatedAction } from '../core/gate-contract.js'
import { gateEnabledForAction } from '../core/gate-engine.js'

const repoRoot = '/repo'

function gatedAction(partial: Omit<GatedAction, 'contractVersion' | 'repoRoot'>): GatedAction {
  return { contractVersion: GATE_CONTRACT_VERSION, repoRoot, ...partial }
}

describe('gateEnabledForAction', () => {
  it('honors gates.shell for shell actions only', () => {
    const config = mergeConfig({
      gates: { shell: false, subagent: true, fileMutation: true, toolShell: true },
    })
    expect(
      gateEnabledForAction(
        config,
        gatedAction({ kind: 'shell', command: 'git status', cwd: repoRoot }),
      ),
    ).toBe(false)
  })

  it('honors gates.subagent for subagent actions only', () => {
    const config = mergeConfig({
      gates: { shell: true, subagent: false, fileMutation: true, toolShell: true },
    })
    expect(
      gateEnabledForAction(config, gatedAction({ kind: 'subagent', cwd: repoRoot, payload: {} })),
    ).toBe(false)
  })

  it('disables all tool actions when both tool gates are false', () => {
    const config = mergeConfig({
      gates: { shell: true, subagent: true, fileMutation: false, toolShell: false },
    })
    for (const toolName of ['Read', 'Grep', 'Glob', 'Write', 'Shell', 'FutureTool']) {
      expect(
        gateEnabledForAction(
          config,
          gatedAction({
            kind: 'tool',
            cwd: repoRoot,
            toolName,
            payload: { tool_name: toolName },
          }),
        ),
      ).toBe(false)
    }
  })

  it('does not use tool-name whitelist when tool gates are enabled', () => {
    const config = mergeConfig({
      gates: { shell: true, subagent: true, fileMutation: true, toolShell: false },
    })
    expect(
      gateEnabledForAction(
        config,
        gatedAction({
          kind: 'tool',
          cwd: repoRoot,
          toolName: 'Read',
          payload: { tool_name: 'Read' },
        }),
      ),
    ).toBe(true)
    expect(
      gateEnabledForAction(
        config,
        gatedAction({
          kind: 'tool',
          cwd: repoRoot,
          toolName: 'Write',
          payload: { tool_name: 'Write' },
        }),
      ),
    ).toBe(true)
  })
})
