import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3, normalizeConfig } from '../core/config.js'
import { isContainedUnknownExecutionEligible } from '../core/contained-execution/eligibility.js'
import type { EffectPlan, EffectRequirement } from '../core/effect-ir/types.js'
import type { ClassifyResult } from '../core/types.js'
import { classifyShellCore } from './helpers/shell-classify.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'app')

type ContainedUnknownResult = ClassifyResult & {
  axes: NonNullable<ClassifyResult['axes']>
  effectPlan: EffectPlan
}

function configWithContainedExecution(enabled = true) {
  return normalizeConfig({
    ...DEFAULT_CONFIG_V3,
    sandbox: {
      enabled,
      runtime: enabled ? 'container' : 'none',
      denyNetworkByDefault: true,
      containedExecution: {
        enabled,
        image: enabled ? 'registry.example/contained-runner:latest' : null,
        timeoutMs: 30_000,
        memoryMiB: 2048,
        cpus: 2,
        pids: 256,
      },
    },
  })
}

describe('contained unknown execution eligibility', () => {
  it.each([
    'fictional-runner verify',
    "bin/rails runner 'Record.count'",
    'bundle exec rspec --dry-run',
  ])('uses the same effect-based decision for unknown local command %s', async (command) => {
    const result = await classifyShellCore(command, cwd, repoRoot)

    expect(result.reason).toBe('unknown_local_effect')
    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), 'shell', result),
    ).toBe(true)
  })

  it('rejects every effect or signal outside the contained local subset', () => {
    const baseline = containedUnknownResult()
    const config = configWithContainedExecution()
    const risky: Array<[string, ClassifyResult]> = [
      ['network', withRequirement(baseline, networkRequirement())],
      ['secret', withRequirement(baseline, secretRequirement())],
      ['control plane', withRequirement(baseline, controlPlaneRequirement())],
      ['outside workspace', { ...baseline, axes: { ...baseline.axes, location: 'repo_outside' } }],
      ['Tier0', withSignals(baseline, ['tier0_future_remote_mutation'])],
      ['high stakes', withSignals(baseline, ['high_stakes_path'])],
      ['pipe-to-shell', withSignals(baseline, ['pipe_to_shell'])],
      ['dynamic evaluation', withSignals(baseline, ['dynamic_shell_evaluation'])],
      ['command substitution', withSignals(baseline, ['command_substitution'])],
      [
        'unparseable shell',
        { ...baseline, effectPlan: { ...baseline.effectPlan, opacity: 'unparseable' } },
      ],
    ]

    for (const [category, result] of risky) {
      expect(isContainedUnknownExecutionEligible(config, 'shell', result), category).toBe(false)
    }
  })

  it('requires the contained opt-in, a shell gate, an unknown reason, and safe plan context', () => {
    const baseline = containedUnknownResult()
    const enabled = configWithContainedExecution()
    const shellGateDisabled = normalizeConfig({
      ...enabled,
      gates: { ...enabled.gates, shell: false },
    })
    const cases: Array<
      [string, ReturnType<typeof configWithContainedExecution>, 'shell' | 'tool', ClassifyResult]
    > = [
      ['contained execution disabled', configWithContainedExecution(false), 'shell', baseline],
      ['shell gate disabled', shellGateDisabled, 'shell', baseline],
      ['non-shell gate', enabled, 'tool', baseline],
      ['known-safe classification', enabled, 'shell', { ...baseline, reason: 'read_only' }],
      [
        'non-local classification',
        enabled,
        'shell',
        { ...baseline, axes: { ...baseline.axes, location: 'unknown' } },
      ],
      [
        'opaque plan',
        enabled,
        'shell',
        { ...baseline, effectPlan: { ...baseline.effectPlan, opacity: 'opaque' } },
      ],
      ['no process execution', enabled, 'shell', withoutProcessRequirement(baseline)],
    ]

    for (const [condition, config, kind, result] of cases) {
      expect(isContainedUnknownExecutionEligible(config, kind, result), condition).toBe(false)
    }

    const recursive: ContainedUnknownResult = {
      ...baseline,
      effectPlan: { ...baseline.effectPlan, opacity: 'recursive' },
    }
    expect(isContainedUnknownExecutionEligible(enabled, 'shell', recursive)).toBe(false)
    expect(
      isContainedUnknownExecutionEligible(enabled, 'shell', safelyExpandedRecursive(recursive)),
    ).toBe(true)
  })

  it('keeps ecosystem-specific decoders, command authority, and corpus data out of eligibility', async () => {
    const source = await readFile(
      new URL('../core/contained-execution/eligibility.ts', import.meta.url),
      'utf8',
    )

    expect(source).not.toMatch(/\b(?:rails|rspec|ruby|bundler)\b/i)
    expect(source).not.toMatch(
      /\b(?:allowlist|commandRedacted|corpus|decode|decoder|fingerprint|normalizedCommand|segmentHead)\b/,
    )
  })
})

function containedUnknownResult(): ContainedUnknownResult {
  const requirements = [
    {
      tag: 'process.exec' as const,
      action: 'process.exec' as const,
      resource: {
        kind: 'executable' as const,
        command: 'fictional-runner',
        operation: 'spawn' as const,
      },
      evidence: { level: 'possible' as const, signals: [], basis: ['test'] },
      provenance: {},
    },
    {
      tag: 'indeterminate' as const,
      action: 'indeterminate' as const,
      resource: { kind: 'unknown' as const },
      evidence: { level: 'indeterminate' as const, signals: [], basis: ['test'] },
      provenance: {},
    },
  ] satisfies EffectRequirement[]
  const effectPlan: EffectPlan = {
    version: 1,
    root: {
      kind: 'exec',
      commandRedacted: 'fictional-runner verify',
      segmentHead: 'fictional-runner',
      requirements,
    },
    inputFingerprint: 'arbitrary-fingerprint',
    opacity: 'transparent',
    disposition: 'effects',
    completeness: 'partial',
    signals: [],
  }
  return {
    verdict: 'deny_pending_approval',
    reason: 'unknown_local_effect',
    fingerprint: 'arbitrary-fingerprint',
    assessment: {
      reversibility: 'irreversible',
      external: false,
      blastRadius: 'repo_local',
      confidence: 0.7,
      signals: [],
    },
    axes: {
      location: 'repo_local',
      opacity: 'transparent',
      effect: 'unknown',
      confidence: 'deterministic',
      would: 'ask',
      by: 'verdict',
      commandRedacted: 'fictional-runner verify',
      commandFingerprint: 'arbitrary-fingerprint',
      signals: [],
    },
    effectPlan,
  }
}

function withRequirement(
  result: ContainedUnknownResult,
  requirement: EffectRequirement,
): ContainedUnknownResult {
  const plan = result.effectPlan
  return {
    ...result,
    effectPlan: {
      ...plan,
      root: {
        kind: 'exec',
        commandRedacted: 'fictional-runner verify',
        segmentHead: 'fictional-runner',
        requirements: [...(plan.root.kind === 'exec' ? plan.root.requirements : []), requirement],
      },
    },
  }
}

function withSignals(
  result: ContainedUnknownResult,
  signals: readonly string[],
): ContainedUnknownResult {
  return {
    ...result,
    assessment: { ...result.assessment, signals: [...signals] },
    axes: { ...result.axes, signals: [...signals] },
    effectPlan: { ...result.effectPlan, signals: [...signals] },
  }
}

function withoutProcessRequirement(result: ContainedUnknownResult): ContainedUnknownResult {
  const plan = result.effectPlan
  return {
    ...result,
    effectPlan: {
      ...plan,
      root: {
        kind: 'exec',
        commandRedacted: 'fictional-runner verify',
        segmentHead: 'fictional-runner',
        requirements:
          plan.root.kind === 'exec'
            ? plan.root.requirements.filter((requirement) => requirement.action !== 'process.exec')
            : [],
      },
    },
  }
}

function safelyExpandedRecursive(result: ContainedUnknownResult): ContainedUnknownResult {
  const plan = result.effectPlan
  if (plan.root.kind !== 'exec') {
    throw new Error('test fixture must have an exec root')
  }
  const [first, ...rest] = plan.root.requirements
  if (!first) {
    throw new Error('test fixture must contain a requirement')
  }
  return {
    ...result,
    effectPlan: {
      ...plan,
      root: {
        ...plan.root,
        requirements: [
          { ...first, provenance: { ...first.provenance, innerCommand: 'verify' } },
          ...rest,
        ],
      },
    },
  }
}

function networkRequirement(): EffectRequirement {
  return {
    tag: 'network.connect',
    action: 'network.connect',
    resource: { kind: 'network', host: 'example.test', mode: 'read', payload: 'none' },
    evidence: { level: 'certain', signals: [], basis: ['test'] },
    provenance: {},
  }
}

function secretRequirement(): EffectRequirement {
  return {
    tag: 'secret.read',
    action: 'secret.read',
    resource: { kind: 'path', path: `${repoRoot}/.env` },
    evidence: { level: 'certain', signals: [], basis: ['test'] },
    provenance: {},
  }
}

function controlPlaneRequirement(): EffectRequirement {
  return {
    tag: 'control_plane.write',
    action: 'control_plane.write',
    resource: { kind: 'path', path: `${repoRoot}/.belay/config.json` },
    evidence: { level: 'certain', signals: [], basis: ['test'] },
    provenance: {},
  }
}
