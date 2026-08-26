import { describe, expect, it } from 'vitest'

import { collectRequirements, lowerShellEffectPlan } from '../../core/effect-ir/index.js'
import { classifyShellCore } from '../helpers/shell-classify.js'

const cwd = '/workspace/project'
const repoRoot = cwd
const verdictRank = { allow: 0, allow_flagged: 1, deny_pending_approval: 2 } as const

function nestShell(command: string, count: number): string {
  let nested = command
  for (let index = 0; index < count; index += 1) nested = `sh -c ${JSON.stringify(nested)}`
  return nested
}

describe('recursive wrapper monotonicity', () => {
  it.each([
    'git status',
    'git push origin main',
    'rm -rf ../.git',
  ])('does not weaken the base decision through recursive wrappers: %s', async (base) => {
    const commands = [
      base,
      `sh -c ${JSON.stringify(base)}`,
      nestShell(base, 2),
      `docker compose run --rm app sh -c ${JSON.stringify(base)}`,
    ]
    const verdicts = await Promise.all(
      commands.map((command) => classifyShellCore(command, cwd, repoRoot)),
    )
    const baseRank = verdictRank[verdicts[0]?.verdict ?? 'deny_pending_approval']

    expect(verdicts.slice(1).every((result) => verdictRank[result.verdict] >= baseRank)).toBe(true)
  })

  it('fails closed immediately beyond the recursive lowering depth boundary', () => {
    const supported = lowerShellEffectPlan({
      command: nestShell('git status', 8),
      cwd,
      repoRoot,
      inputFingerprint: 'depth-supported',
    })
    const exceeded = lowerShellEffectPlan({
      command: nestShell('git status', 9),
      cwd,
      repoRoot,
      inputFingerprint: 'depth-exceeded',
    })

    expect(supported.completeness).toBe('complete')
    expect(collectRequirements(supported.root)).toContainEqual(
      expect.objectContaining({
        action: 'process.exec',
        evidence: expect.objectContaining({
          signals: expect.arrayContaining(['git.status']),
        }),
      }),
    )
    expect(exceeded.completeness).toBe('partial')
    expect(collectRequirements(exceeded.root)).toContainEqual(
      expect.objectContaining({
        action: 'indeterminate',
        evidence: expect.objectContaining({
          signals: expect.arrayContaining(['shell.lower_depth_exceeded']),
        }),
      }),
    )
  })

  it('supports 32 transparent wrappers and fails closed on the 33rd', () => {
    const supportedCommand = `${'sudo '.repeat(32)}git status`
    const exceededCommand = `${'sudo '.repeat(33)}git status`
    const supported = lowerShellEffectPlan({
      command: supportedCommand,
      cwd,
      repoRoot,
      inputFingerprint: 'wrapper-supported',
    })
    const exceeded = lowerShellEffectPlan({
      command: exceededCommand,
      cwd,
      repoRoot,
      inputFingerprint: 'wrapper-exceeded',
    })

    expect(supported.completeness).toBe('complete')
    expect(exceeded.completeness).toBe('partial')
  })
})
