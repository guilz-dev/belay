import { describe, expect, it } from 'vitest'

import { mergeConfig } from '../core/config.js'
import { hashDecisionConfig } from '../core/decision-config-fingerprint.js'
import { collectRequirements } from '../core/effect-ir/build.js'
import { lowerShellEffectPlan } from '../core/effect-ir/shell-lower.js'
import type { EffectPlan } from '../core/effect-ir/types.js'
import {
  authorizationProjectionsEqual,
  parseLegacyShell,
  parseMvdanShell,
  routeShellFrontend,
  selectCanonicalEffectPlan,
  validateParsedProgram,
} from '../core/shell-frontend/index.js'

const lowerParams = {
  cwd: '/repo',
  repoRoot: '/repo',
  inputFingerprint: 'fingerprint',
}

describe('shell frontend contract', () => {
  it('projects a simple command without claiming unprojected structure is complete', () => {
    const program = parseLegacyShell('git status')
    expect(program.completeness).toBe('complete')
    expect(program.diagnostics).toEqual([])
    expect(program.nodes[0]?.kind).toBe('command')
  })

  it('keeps unparseable input partial instead of dropping it', () => {
    const program = parseLegacyShell('(curl https://example.com)')
    expect(program.completeness).toBe('partial')
    expect(program.nodes.some((node) => node.kind === 'unsupported')).toBe(true)
    expect(program.diagnostics.some((diagnostic) => diagnostic.code === 'invalid_syntax')).toBe(
      true,
    )
  })

  it('rejects a span that splits a UTF-8 code point', () => {
    const source = 'é'
    const sourceBytes = Buffer.byteLength(source, 'utf8')
    const program = validateParsedProgram(
      {
        version: 1,
        sourceBytes,
        completeness: 'complete',
        nodes: [
          {
            kind: 'unsupported',
            upstreamKind: 'bad-span',
            span: { startByte: 1, endByte: sourceBytes },
          },
        ],
        diagnostics: [],
      },
      source,
    )
    expect(program.completeness).toBe('partial')
    expect(program.diagnostics.some((diagnostic) => diagnostic.code === 'invalid_span')).toBe(true)
  })

  it('reports missing mvdan artifacts as partial and never complete', () => {
    const program = parseMvdanShell('git status')
    expect(program.completeness).toBe('partial')
    expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'artifact_unavailable',
    ])
  })
})

describe('shell frontend router', () => {
  it('does not consult mvdan in legacy mode', async () => {
    const route = await routeShellFrontend('git status', 'legacy')
    expect(route.canonicalId).toBe('legacy-v1')
    expect(route.candidateProgram).toBeUndefined()
    expect(route.disagreement).toBe(false)
  })

  it('keeps the legacy program canonical in shadow mode', async () => {
    const route = await routeShellFrontend('git status', 'shadow')
    expect(route.canonicalId).toBe('legacy-v1')
    expect(route.candidateProgram?.diagnostics[0]?.code).toBe('artifact_unavailable')
    expect(route.disagreement).toBe(false)
  })

  it('does not parse with the legacy frontend when mvdan is authoritative', async () => {
    const route = await routeShellFrontend('git status', 'mvdan')
    expect(route.canonicalId).toBe('mvdan-v1')
    expect(route.candidateProgram).toBeUndefined()
    expect(route.canonicalProgram?.diagnostics[0]?.code).toBe('artifact_unavailable')
  })
})

describe('shell frontend authority', () => {
  it('leaves legacy lowering unchanged', () => {
    const baseline = lowerShellEffectPlan({ ...lowerParams, command: 'git status' })
    const explicit = lowerShellEffectPlan({
      ...lowerParams,
      command: 'git status',
      shellFrontendMode: 'legacy',
    })
    expect(explicit).toEqual(baseline)
    expect(
      collectRequirements(explicit.root).some((requirement) => requirement.tag === 'process.exec'),
    ).toBe(true)
  })

  it('does not change the canonical plan when the shadow candidate is unavailable', () => {
    const legacy = lowerShellEffectPlan({
      ...lowerParams,
      command: 'git status',
      shellFrontendMode: 'legacy',
    })
    const shadow = lowerShellEffectPlan({
      ...lowerParams,
      command: 'git status',
      shellFrontendMode: 'shadow',
    })
    expect(shadow).toEqual(legacy)
  })

  it('fail-closes canary and mvdan without copying legacy requirements', () => {
    for (const shellFrontendMode of ['canary', 'mvdan'] as const) {
      const plan = lowerShellEffectPlan({
        ...lowerParams,
        command: 'git status',
        shellFrontendMode,
      })
      const requirements = collectRequirements(plan.root)
      expect(plan.completeness).toBe('partial')
      expect(requirements.every((requirement) => requirement.tag === 'indeterminate')).toBe(true)
      expect(plan.signals).toContain('parser.artifact_unavailable')
      expect(requirements.some((requirement) => requirement.tag === 'process.exec')).toBe(false)
    }
  })

  it('records canary disagreement without unioning the legacy plan', () => {
    const plan = lowerShellEffectPlan({
      ...lowerParams,
      command: 'git status',
      shellFrontendMode: 'canary',
    })
    expect(plan.signals).toContain('parser.disagreement')
    expect(plan.signals).not.toContain('git.read')
  })
})

describe('shellFrontendMode config', () => {
  it('defaults to legacy and changes the decision fingerprint when the mode changes', () => {
    const legacy = mergeConfig({})
    expect(legacy.classifier.shellFrontendMode).toBe('legacy')
    const shadow = mergeConfig({
      classifier: { shellFrontendMode: 'shadow' },
    })
    expect(hashDecisionConfig(shadow)).not.toBe(hashDecisionConfig(legacy))
  })

  it('rejects an unknown mode instead of falling back', () => {
    expect(() =>
      mergeConfig({
        version: 4,
        classifier: { shellFrontendMode: 'allow' as 'legacy' },
      }),
    ).toThrow(/shellFrontendMode/)
  })

  it('treats signal-only differences as canary disagreement', () => {
    const strict = effectPlan(['shell.grammar_incomplete'])
    const loose = effectPlan([])
    expect(authorizationProjectionsEqual(strict, loose)).toBe(false)
    let disagreed = false
    selectCanonicalEffectPlan({
      mode: 'canary',
      legacy: strict,
      mvdan: loose,
      withDisagreement: (plan) => {
        disagreed = true
        return plan
      },
    })
    expect(disagreed).toBe(true)
  })
})

function effectPlan(signals: string[]): EffectPlan {
  return {
    version: 1,
    inputFingerprint: 'fingerprint',
    opacity: 'transparent',
    disposition: 'effects',
    completeness: 'complete',
    signals,
    root: {
      kind: 'exec',
      commandRedacted: 'git status',
      segmentHead: 'git',
      requirements: [
        {
          tag: 'process.exec',
          action: 'process.exec',
          resource: { kind: 'executable', command: 'git', operation: 'inspect' },
          evidence: {
            level: 'certain',
            signals,
            basis: ['shell_semantic_lowering'],
          },
          provenance: { segment: 'git status' },
        },
      ],
    },
  }
}
