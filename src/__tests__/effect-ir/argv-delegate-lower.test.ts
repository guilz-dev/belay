import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectRequirements, lowerShellEffectPlan } from '../../core/effect-ir/index.js'
import { mergeConfig } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')
const config = mergeConfig({})

async function classify(command: string) {
  return classifyShell(command, cwd, repoRoot, config)
}

function requirements(command: string) {
  const plan = lowerShellEffectPlan({
    command,
    cwd,
    repoRoot,
    inputFingerprint: `fixture:${command}`,
  })
  return collectRequirements(plan.root)
}

describe('argv-delegate lowering', () => {
  it('lowers rtk git status --short like git status --short', async () => {
    const direct = await classify('git status --short')
    const wrapped = await classify('rtk git status --short')
    expect(wrapped.verdict).toBe(direct.verdict)
    expect(wrapped.reason).toBe(direct.reason)
  })

  it('lowers fictional-runner git diff like git diff', async () => {
    const direct = await classify('git diff')
    const wrapped = await classify('fictional-runner git diff')
    expect(wrapped.verdict).toBe(direct.verdict)
    expect(wrapped.reason).toBe(direct.reason)
  })

  it('inherits make lowering for argv-delegated make invocations', async () => {
    const direct = await classify('make test-fast ARGS=foo')
    const wrapped = await classify('rtk make test-fast ARGS=foo')
    expect(wrapped.verdict).toBe(direct.verdict)
    expect(wrapped.reason).toBe(direct.reason)
  })

  it('records wrapper spawn and inner requirements for delegated git status', () => {
    const reqs = requirements('rtk git status')
    expect(reqs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'process.exec',
          resource: { kind: 'executable', command: 'rtk', operation: 'inspect' },
          evidence: expect.objectContaining({
            signals: expect.arrayContaining(['process.argv_delegate']),
          }),
        }),
        expect.objectContaining({
          action: 'process.exec',
          resource: { kind: 'executable', command: 'git', operation: 'inspect' },
        }),
      ]),
    )
    expect(reqs).not.toContainEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({
          signals: expect.arrayContaining(['process.grammar_unknown']),
        }),
      }),
    )
  })

  it('stays opaque when wrapper options precede the remainder', () => {
    const reqs = requirements('unknown-wrapper --network git status')
    expect(reqs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'indeterminate',
          evidence: expect.objectContaining({
            signals: expect.arrayContaining(['argv_delegate_wrapper_options']),
          }),
        }),
      ]),
    )
  })

  it('keeps grammar_unknown for wrapper-only invocations', () => {
    const reqs = requirements('unknown-wrapper')
    expect(reqs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.objectContaining({
            signals: expect.arrayContaining(['process.grammar_unknown']),
          }),
        }),
      ]),
    )
  })
})
