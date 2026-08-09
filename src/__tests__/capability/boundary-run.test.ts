import { describe, expect, it } from 'vitest'

import { boundaryMountReadOnlyFromPrediction } from '../../core/capability/boundary-run.js'
import type { ClassifyResult } from '../../core/types.js'

function classify(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    verdict: 'allow',
    reason: 'read_only',
    summary: '',
    fingerprint: 'fp',
    assessment: {
      reversibility: 'reversible',
      external: false,
      blastRadius: 'local',
      confidence: 1,
      signals: [],
    },
    ...overrides,
  }
}

describe('boundaryMountReadOnlyFromPrediction', () => {
  it('uses read-write mount for predicted fs.write', () => {
    expect(
      boundaryMountReadOnlyFromPrediction(
        classify({
          capabilityRequests: [
            {
              version: 1,
              principal: { repoRoot: '/repo', sessionHash: 's' },
              action: 'fs.write',
              resource: { kind: 'path', path: '/repo/a.txt' },
              context: {
                cwd: '/repo',
                inputFingerprint: 'fp',
                hookKind: 'shell',
                analysisBasis: [],
              },
              evidence: { level: 'certain', signals: [] },
            },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('uses read-only mount for predicted fs.read', () => {
    expect(
      boundaryMountReadOnlyFromPrediction(
        classify({
          capabilityRequests: [
            {
              version: 1,
              principal: { repoRoot: '/repo', sessionHash: 's' },
              action: 'fs.read',
              resource: { kind: 'path', path: '/repo/a.txt' },
              context: {
                cwd: '/repo',
                inputFingerprint: 'fp',
                hookKind: 'shell',
                analysisBasis: [],
              },
              evidence: { level: 'certain', signals: [] },
            },
          ],
        }),
      ),
    ).toBe(true)
  })

  it('defaults to read-only when effect is unknown', () => {
    expect(
      boundaryMountReadOnlyFromPrediction(
        classify({
          axes: {
            effect: 'unknown',
            location: 'unknown',
            opacity: 'opaque',
            confidence: 'deterministic',
            would: 'allow',
            by: 'policy',
          },
        }),
      ),
    ).toBe(true)
  })

  it('uses read-write mount when any bundled capability request writes', () => {
    expect(
      boundaryMountReadOnlyFromPrediction(
        classify({
          capabilityRequests: [
            {
              version: 1,
              principal: { repoRoot: '/repo', sessionHash: 's' },
              action: 'fs.read',
              resource: { kind: 'path', path: '/repo/a.txt' },
              context: {
                cwd: '/repo',
                inputFingerprint: 'fp',
                hookKind: 'shell',
                analysisBasis: [],
              },
              evidence: { level: 'certain', signals: [] },
            },
            {
              version: 1,
              principal: { repoRoot: '/repo', sessionHash: 's' },
              action: 'fs.write',
              resource: { kind: 'path', path: '/repo/b.txt' },
              context: {
                cwd: '/repo',
                inputFingerprint: 'fp',
                hookKind: 'shell',
                analysisBasis: [],
              },
              evidence: { level: 'certain', signals: [] },
            },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('uses read-write mount for indeterminate action when effect is local_mutation', () => {
    expect(
      boundaryMountReadOnlyFromPrediction(
        classify({
          verdict: 'allow_flagged',
          capabilityRequests: [
            {
              version: 1,
              principal: { repoRoot: '/repo', sessionHash: 's' },
              action: 'indeterminate',
              resource: { kind: 'unknown' },
              context: {
                cwd: '/repo',
                inputFingerprint: 'fp',
                hookKind: 'shell',
                analysisBasis: [],
              },
              evidence: { level: 'indeterminate', signals: [] },
            },
          ],
          axes: {
            effect: 'local_mutation',
            location: 'repo_local',
            opacity: 'transparent',
            confidence: 'assumed_repo_local',
            would: 'allow',
            by: 'policy',
          },
        }),
      ),
    ).toBe(false)
  })
})
