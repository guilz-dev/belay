import { describe, expect, it } from 'vitest'

import {
  buildShellEffectPlan,
  collectRequirements,
  hashEffectPlan,
  type ShellEffectRequirement,
  type ShellEffectSegment,
} from '../../core/effect-ir/index.js'

function requirement(
  overrides: Partial<ShellEffectRequirement> &
    Pick<ShellEffectRequirement, 'action' | 'resource' | 'tag'>,
): ShellEffectRequirement {
  return {
    evidence: {
      level: 'certain',
      signals: ['fixture'],
      basis: ['shell:test'],
    },
    provenance: { segment: 'fixture' },
    ...overrides,
  }
}

function segment(overrides: Partial<ShellEffectSegment> = {}): ShellEffectSegment {
  return {
    commandRedacted: 'fixture',
    segmentHead: 'fixture',
    requirements: [],
    completeness: 'complete',
    opacity: 'transparent',
    signals: [],
    ...overrides,
  }
}

describe('general-shell effect plan builder', () => {
  it('merges one exec node per analyzed segment and preserves typed effect metadata', () => {
    const curlProvenance = { segment: 'curl https://example.com' }
    const killProvenance = { segment: 'kill 123' }
    const plan = buildShellEffectPlan({
      inputFingerprint: 'fp-shell-chain',
      segments: [
        segment({
          commandRedacted: 'curl https://example.com',
          segmentHead: 'curl',
          requirements: [
            requirement({
              tag: 'network.connect',
              action: 'network.connect',
              resource: {
                kind: 'network',
                host: 'example.com',
                protocol: 'https',
                mode: 'read',
                payload: 'none',
              },
              provenance: curlProvenance,
            }),
          ],
        }),
        segment({
          commandRedacted: 'kill 123',
          segmentHead: 'kill',
          requirements: [
            requirement({
              tag: 'process.exec',
              action: 'process.exec',
              resource: {
                kind: 'executable',
                command: 'kill',
                operation: 'signal',
              },
              provenance: killProvenance,
            }),
            requirement({
              tag: 'git.ref.write',
              action: 'git.ref.write',
              resource: {
                kind: 'git-ref',
                ref: 'refs/remotes/origin/main',
                scope: 'remote',
              },
              provenance: killProvenance,
            }),
          ],
        }),
      ],
    })

    expect(plan.root).toMatchObject({
      kind: 'merge',
      children: [
        {
          kind: 'exec',
          commandRedacted: 'curl https://example.com',
          segmentHead: 'curl',
        },
        {
          kind: 'exec',
          commandRedacted: 'kill 123',
          segmentHead: 'kill',
        },
      ],
    })
    expect(collectRequirements(plan.root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: expect.objectContaining({ mode: 'read', payload: 'none' }),
          provenance: curlProvenance,
        }),
        expect.objectContaining({
          resource: expect.objectContaining({ operation: 'signal' }),
          provenance: killProvenance,
        }),
        expect.objectContaining({
          resource: expect.objectContaining({ scope: 'remote' }),
          provenance: killProvenance,
        }),
      ]),
    )
  })

  it('is effect-free exactly when analysis is complete and requirements are empty', () => {
    const plan = buildShellEffectPlan({
      inputFingerprint: 'fp-effect-free',
      segments: [
        segment({
          commandRedacted: 'printf ok',
          segmentHead: 'printf',
        }),
      ],
    })

    expect(plan).toMatchObject({
      completeness: 'complete',
      disposition: 'effect_free',
    })
    expect(collectRequirements(plan.root)).toEqual([])
  })

  it('keeps distinct operations on the same resource', () => {
    const plan = buildShellEffectPlan({
      inputFingerprint: 'fp-distinct-network-semantics',
      segments: [
        segment({
          commandRedacted: 'curl https://example.com',
          segmentHead: 'curl',
          requirements: [
            requirement({
              tag: 'network.connect',
              action: 'network.connect',
              resource: {
                kind: 'network',
                host: 'example.com',
                mode: 'read',
                payload: 'none',
              },
            }),
          ],
        }),
        segment({
          commandRedacted: 'curl -d value https://example.com',
          segmentHead: 'curl',
          requirements: [
            requirement({
              tag: 'network.connect',
              action: 'network.connect',
              resource: {
                kind: 'network',
                host: 'example.com',
                mode: 'mutate',
                payload: 'present',
              },
            }),
          ],
        }),
      ],
    })

    expect(
      collectRequirements(plan.root).map((entry) =>
        entry.resource.kind === 'network'
          ? [entry.resource.mode, entry.resource.payload]
          : undefined,
      ),
    ).toEqual([
      ['read', 'none'],
      ['mutate', 'present'],
    ])
  })

  it('includes process operation metadata in the canonical plan hash', () => {
    const buildProcessPlan = (operation: 'inspect' | 'spawn') =>
      buildShellEffectPlan({
        inputFingerprint: 'fp-process-operation',
        segments: [
          segment({
            commandRedacted: 'docker info',
            segmentHead: 'docker',
            requirements: [
              requirement({
                tag: 'process.exec',
                action: 'process.exec',
                resource: {
                  kind: 'executable',
                  command: 'docker',
                  operation,
                },
              }),
            ],
          }),
        ],
      })

    expect(hashEffectPlan(buildProcessPlan('inspect'))).not.toBe(
      hashEffectPlan(buildProcessPlan('spawn')),
    )
  })

  it('adds indeterminate to a partial segment without replacing known requirements', () => {
    const known = requirement({
      tag: 'fs.write',
      action: 'fs.write',
      resource: { kind: 'path', path: '/workspace/project/output.txt' },
      provenance: { segment: 'opaque > output.txt' },
    })
    const plan = buildShellEffectPlan({
      inputFingerprint: 'fp-partial',
      segments: [
        segment({
          commandRedacted: 'opaque > output.txt',
          segmentHead: 'opaque',
          requirements: [known],
          completeness: 'partial',
          opacity: 'opaque',
          signals: ['shell.substitution_unresolved'],
        }),
      ],
    })

    const requirements = collectRequirements(plan.root)
    expect(plan).toMatchObject({
      completeness: 'partial',
      disposition: 'effects',
      opacity: 'opaque',
    })
    expect(requirements).toContainEqual(expect.objectContaining(known))
    expect(requirements).toContainEqual(
      expect.objectContaining({
        tag: 'indeterminate',
        action: 'indeterminate',
        resource: { kind: 'unknown' },
        evidence: expect.objectContaining({ level: 'indeterminate' }),
        provenance: { segment: 'opaque > output.txt' },
      }),
    )
  })

  it('treats an explicit indeterminate requirement as partial analysis', () => {
    const plan = buildShellEffectPlan({
      inputFingerprint: 'fp-explicit-indeterminate',
      segments: [
        segment({
          requirements: [
            requirement({
              tag: 'indeterminate',
              action: 'indeterminate',
              resource: { kind: 'unknown' },
              evidence: {
                level: 'indeterminate',
                signals: ['shell.unknown'],
                basis: ['shell:test'],
              },
            }),
          ],
        }),
      ],
    })

    expect(plan.completeness).toBe('partial')
    expect(plan.disposition).toBe('effects')
  })

  it('derives envelope completeness from canonical root requirements', () => {
    const plan = buildShellEffectPlan({
      inputFingerprint: 'fp-canonical-envelope',
      segments: [
        segment({
          commandRedacted: 'first',
          requirements: [
            requirement({
              tag: 'indeterminate',
              action: 'fs.write',
              resource: { kind: 'path', path: '/workspace/project/output.txt' },
              evidence: {
                level: 'possible',
                signals: ['z-possible'],
                basis: ['shell:first'],
              },
            }),
          ],
        }),
        segment({
          commandRedacted: 'second',
          requirements: [
            requirement({
              tag: 'fs.write',
              action: 'fs.write',
              resource: { kind: 'path', path: '/workspace/project/output.txt' },
              evidence: {
                level: 'certain',
                signals: ['a-certain'],
                basis: ['shell:second'],
              },
            }),
          ],
        }),
      ],
    })

    const canonicalRequirements = collectRequirements(plan.root)
    expect(canonicalRequirements.map((entry) => entry.tag)).toEqual(['fs.write'])
    expect(plan.completeness).toBe('complete')
    expect(plan.disposition).toBe(canonicalRequirements.length === 0 ? 'effect_free' : 'effects')
  })

  it('orders plan signals deterministically', () => {
    const build = (signals: string[]) =>
      buildShellEffectPlan({
        inputFingerprint: 'fp-signal-order',
        signals,
        segments: [
          segment({
            signals: [...signals].reverse(),
            requirements: [
              requirement({
                tag: 'fs.write',
                action: 'fs.write',
                resource: { kind: 'path', path: '/workspace/project/output.txt' },
                evidence: {
                  level: 'certain',
                  signals,
                  basis: ['shell:signals'],
                },
              }),
            ],
          }),
        ],
      })

    expect(build(['z-last', 'a-first']).signals).toEqual(['a-first', 'z-last'])
    expect(build(['a-first', 'z-last']).signals).toEqual(['a-first', 'z-last'])
  })
})
